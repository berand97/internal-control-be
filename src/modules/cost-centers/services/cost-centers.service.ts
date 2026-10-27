import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import { isUniqueViolation } from '../../../common/exceptions/postgres-error.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import { codeMatchesPrefix, prefixRangeMessage } from '../domain/code-prefix.js';
import { CreateCostCenterDto } from '../dto/create-cost-center.dto.js';
import { QueryCostCentersDto } from '../dto/query-cost-centers.dto.js';
import { CostCenterResponseDto } from '../dto/responses/cost-center.response.dto.js';
import { UpdateCostCenterDto } from '../dto/update-cost-center.dto.js';
import { CostCenterSyncSource } from '../enums/cost-center-sync-source.enum.js';
import type { CostCentersRepository } from '../repositories/cost-centers.repository.interface.js';
import type { StructureRemovalResultDto } from '../dto/responses/structure-removal.response.dto.js';
import { CostCenterPlacementService, NO_REQUEST, type RequestMeta } from './cost-center-placement.service.js';
import { OrgStructureHistoryService } from './org-structure-history.service.js';
import { assertCenterRemovable, StructureRemovalService } from './structure-removal.service.js';
import { StructureReconcilerService } from './structure-reconciler.service.js';
import { partialScope } from '../domain/structure-reconcile.js';

const COST_CENTER_ENTITY_TYPE = 'COST_CENTER';

@Injectable()
export class CostCentersService {
  constructor(
    @Inject('CostCentersRepository')
    private readonly costCentersRepository: CostCentersRepository,
    @Inject('AuditLogsRepository')
    private readonly auditLogsRepository: AuditLogsRepository,
    private readonly dataSource: DataSource,
    private readonly placements: CostCenterPlacementService,
    private readonly removal: StructureRemovalService,
    private readonly history: OrgStructureHistoryService,
    private readonly reconciler: StructureReconcilerService,
  ) {}

  async list(
    query: QueryCostCentersDto,
  ): Promise<ReadonlyArray<CostCenterResponseDto>> {
    const items = await this.costCentersRepository.findAll({
      ...(query.q ? { q: query.q } : {}),
      ...(query.organizationalUnitId
        ? { organizationalUnitId: query.organizationalUnitId }
        : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
    });
    return items.map(CostCenterResponseDto.from);
  }

  async getById(id: string): Promise<CostCenterResponseDto> {
    return CostCenterResponseDto.from(await this.requireCenter(id));
  }

  async create(
    dto: CreateCostCenterDto,
    actor: AuthenticatedUser,
    request: RequestMeta = NO_REQUEST,
  ): Promise<CostCenterResponseDto> {
    if (dto.organizationalUnitId) {
      const unit = await this.requireOrgUnit(dto.organizationalUnitId);
      if (unit.codePrefix && !codeMatchesPrefix(dto.externalCode, unit.codePrefix)) {
        const message = prefixRangeMessage(unit.name, unit.codePrefix);
        throw new ApiException(ErrorCode.CostCenterCodeOutOfUnitRange, message, [{ field: 'externalCode', message }]);
      }
    }
    if (dto.parentId) {
      await this.requireCenter(dto.parentId);
    }
    const hasMovement = dto.hasMovement ?? true;
    try {
      const center = await this.dataSource.transaction(async (manager) => {
        const created = await this.costCentersRepository.insert(
          {
            externalCode: dto.externalCode,
            name: dto.name,
            organizationalUnitId: dto.organizationalUnitId ?? null,
            parentId: dto.parentId ?? null,
            acceptsAssets: hasMovement ? (dto.acceptsAssets ?? true) : false,
            hasMovement,
            isActive: dto.isActive ?? true,
            syncSource: CostCenterSyncSource.Manual,
            lastSyncedAt: null,
          },
          manager,
        );
        await this.placements.open(manager, created.id, {
          reason: 'Alta del centro de costo',
          actorId: actor.id,
          ip: request.ip,
          userAgent: request.userAgent,
          source: 'MANUAL',
        });
        await this.auditLogsRepository.record(
          {
            action: AuditAction.CostCenterCreated,
            entityType: COST_CENTER_ENTITY_TYPE,
            entityId: created.id,
            performedBy: actor.id,
            ipAddress: request.ip,
            userAgent: request.userAgent,
            changes: { externalCode: created.externalCode },
          },
          manager,
        );
        await this.reconciler.reconcileWithin(manager, partialScope({ centerCodes: [created.externalCode], centerIds: [created.id] }), {
          actorId: actor.id,
          reason: `Se creó el centro ${created.externalCode}`,
          ...request,
        });
        return created;
      });
      return CostCenterResponseDto.from(center);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiException(ErrorCode.CostCenterExternalCodeExists);
      }
      throw error;
    }
  }

  async update(
    id: string,
    dto: UpdateCostCenterDto,
    actor: AuthenticatedUser,
    request: RequestMeta = NO_REQUEST,
  ): Promise<CostCenterResponseDto> {
    const center = await this.requireCenter(id);
    const structural = [
      ...(dto.organizationalUnitId !== undefined && dto.organizationalUnitId !== center.organizationalUnitId
        ? [{ field: 'organizationalUnitId', message: 'Cámbiela desde la ubicación del centro.' }]
        : []),
      ...(dto.parentId !== undefined && dto.parentId !== center.parentId
        ? [{ field: 'parentId', message: 'Cámbielo desde la ubicación del centro.' }]
        : []),
    ];
    if (structural.length > 0) {
      throw new ApiException(ErrorCode.CostCenterPlacementRequired, undefined, structural);
    }
    const deactivating = dto.isActive === false && center.isActive;
    if (dto.isActive === true && !center.isActive) {
      await this.assertCanReactivate(center);
    }
    await this.dataSource.transaction(async (manager) => {
      if (deactivating) {
        await manager.query('SELECT id FROM cost_center WHERE id = $1 FOR UPDATE', [center.id]);
        assertCenterRemovable(await this.removal.inspectCostCenter(manager, center.id));
      }
      await this.costCentersRepository.update(
        center.id,
        {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.acceptsAssets !== undefined ? { acceptsAssets: dto.acceptsAssets } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
        manager,
      );
      await this.auditLogsRepository.record(
        {
          action: AuditAction.CostCenterUpdated,
          entityType: COST_CENTER_ENTITY_TYPE,
          entityId: center.id,
          performedBy: actor.id,
          ipAddress: request.ip,
          userAgent: request.userAgent,
          changes: { ...dto },
        },
        manager,
      );
      const after = { ...center, ...(dto.name !== undefined ? { name: dto.name } : {}), isActive: dto.isActive ?? center.isActive };
      await this.recordUpdateHistory(manager, center, after, actor);
      if (after.isActive !== center.isActive) {
        await this.reconciler.reconcileWithin(manager, partialScope({ centerCodes: [center.externalCode], centerIds: [center.id] }), {
          actorId: actor.id,
          reason: `Se ${after.isActive ? 'reactivó' : 'archivó'} el centro ${center.externalCode}`,
          ...request,
        });
      }
    });
    return CostCenterResponseDto.from(await this.requireCenter(id));
  }

  private async recordUpdateHistory(
    manager: EntityManager,
    center: { readonly id: string; readonly name: string; readonly isActive: boolean },
    updated: { readonly name: string; readonly isActive: boolean },
    actor: AuthenticatedUser,
  ): Promise<void> {
    await this.history.record(
      manager,
      [
        { entityType: 'COST_CENTER', entityId: center.id, field: 'NAME', oldValue: center.name, newValue: updated.name },
        {
          entityType: 'COST_CENTER',
          entityId: center.id,
          field: 'STATUS',
          oldValue: center.isActive ? 'ACTIVE' : 'ARCHIVED',
          newValue: updated.isActive ? 'ACTIVE' : 'ARCHIVED',
        },
      ],
      { actorId: actor.id, source: 'MANUAL' },
    );
  }

  async remove(
    id: string,
    actor: AuthenticatedUser,
    request: RequestMeta = NO_REQUEST,
  ): Promise<StructureRemovalResultDto> {
    const center = await this.requireCenter(id);
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT id FROM cost_center WHERE id = $1 FOR UPDATE', [center.id]);
      const verdict = assertCenterRemovable(await this.removal.inspectCostCenter(manager, center.id));
      if (verdict.decision === 'DELETE') {
        await this.removal.deleteCostCenter(manager, center.id);
      } else {
        await manager.query('UPDATE cost_center SET is_active = FALSE, updated_at = NOW() WHERE id = $1', [center.id]);
        await this.history.record(
          manager,
          [
            {
              entityType: 'COST_CENTER',
              entityId: center.id,
              field: 'STATUS',
              oldValue: center.isActive ? 'ACTIVE' : 'ARCHIVED',
              newValue: 'ARCHIVED',
            },
          ],
          { actorId: actor.id, source: 'MANUAL', reason: verdict.reason },
        );
      }
      await this.reconciler.reconcileWithin(manager, partialScope({ centerCodes: [center.externalCode], centerIds: [center.id] }), {
        actorId: actor.id,
        reason: `Se ${verdict.decision === 'DELETE' ? 'eliminó' : 'archivó'} el centro ${center.externalCode}`,
        ...request,
      });
      await this.auditLogsRepository.record(
        {
          action: verdict.decision === 'DELETE' ? AuditAction.CostCenterDeleted : AuditAction.CostCenterArchived,
          entityType: COST_CENTER_ENTITY_TYPE,
          entityId: center.id,
          performedBy: actor.id,
          ipAddress: request.ip,
          userAgent: request.userAgent,
          changes: { externalCode: center.externalCode, name: center.name, physical: verdict.decision === 'DELETE' },
        },
        manager,
      );
      return { deleted: verdict.decision === 'DELETE', archived: verdict.decision === 'ARCHIVE', reason: verdict.reason };
    });
  }

  private async assertCanReactivate(center: {
    readonly parentId: string | null;
    readonly organizationalUnitId: string | null;
  }): Promise<void> {
    if (center.parentId) {
      const parent = await this.costCentersRepository.findById(center.parentId);
      if (parent && !parent.isActive) {
        const message = `Su centro padre ${parent.externalCode} · ${parent.name} está archivado. Reactívelo primero.`;
        throw new ApiException(ErrorCode.CostCenterParentInactive, message, [{ field: 'parentId', message }]);
      }
    }
    if (center.organizationalUnitId) {
      const unit = await this.costCentersRepository.findOrgUnitById(center.organizationalUnitId);
      if (unit && !unit.isActive) {
        const message = `Su dependencia ${unit.name} está archivada. Reactívela primero o cambie la ubicación del centro.`;
        throw new ApiException(ErrorCode.CostCenterOrgUnitInactive, message, [{ field: 'organizationalUnitId', message }]);
      }
    }
  }

  private async requireCenter(id: string) {
    const center = await this.costCentersRepository.findById(id);
    if (!center) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return center;
  }

  private async requireOrgUnit(id: string) {
    const unit = await this.costCentersRepository.findOrgUnitById(id);
    if (!unit) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return unit;
  }
}
