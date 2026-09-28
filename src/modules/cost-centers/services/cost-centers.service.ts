import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import { isUniqueViolation } from '../../../common/exceptions/postgres-error.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import { parseCostCenterCsv } from '../csv/parse-cost-center-csv.js';
import { codeMatchesPrefix, prefixRangeMessage } from '../domain/code-prefix.js';
import { CreateCostCenterDto } from '../dto/create-cost-center.dto.js';
import { QueryCostCentersDto } from '../dto/query-cost-centers.dto.js';
import { CostCenterSyncResponseDto } from '../dto/responses/cost-center-sync.response.dto.js';
import { CostCenterResponseDto } from '../dto/responses/cost-center.response.dto.js';
import { UpdateCostCenterDto } from '../dto/update-cost-center.dto.js';
import { CostCenterSyncSource } from '../enums/cost-center-sync-source.enum.js';
import type { CostCentersRepository } from '../repositories/cost-centers.repository.interface.js';
import { CostCenterPlacementService, NO_REQUEST, type RequestMeta } from './cost-center-placement.service.js';

const COST_CENTER_ENTITY_TYPE = 'COST_CENTER';

export interface CsvUpload {
  readonly buffer: Buffer;
  readonly originalname: string;
}

@Injectable()
export class CostCentersService {
  constructor(
    @Inject('CostCentersRepository')
    private readonly costCentersRepository: CostCentersRepository,
    @Inject('AuditLogsRepository')
    private readonly auditLogsRepository: AuditLogsRepository,
    private readonly dataSource: DataSource,
    private readonly placements: CostCenterPlacementService,
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

  /**
   * Un centro nuevo con unidad que tiene prefijo de código debe estar en su rango (los existentes nunca se corrigen:
   * GET /cost-centers/prefix-mismatches los lista). El historial de ubicación se abre en la misma transacción.
   */
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

  /**
   * Nombre, aceptación de activos y estado. La unidad y el padre son parte del historial de ubicación: aquí solo se
   * aceptan iguales a los vigentes; cambiarlos es POST /cost-centers/:id/placement (con motivo).
   */
  async update(
    id: string,
    dto: UpdateCostCenterDto,
    actor: AuthenticatedUser,
    request: RequestMeta = NO_REQUEST,
  ): Promise<CostCenterResponseDto> {
    const center = await this.requireCenter(id);
    const structural = [
      ...(dto.organizationalUnitId !== undefined && dto.organizationalUnitId !== center.organizationalUnitId
        ? [{ field: 'organizationalUnitId', message: 'Use POST /cost-centers/{id}/placement' }]
        : []),
      ...(dto.parentId !== undefined && dto.parentId !== center.parentId
        ? [{ field: 'parentId', message: 'Use POST /cost-centers/{id}/placement' }]
        : []),
    ];
    if (structural.length > 0) {
      throw new ApiException(ErrorCode.CostCenterPlacementRequired, undefined, structural);
    }
    if (dto.isActive === false && center.isActive) {
      await this.assertNoActiveAssets(center.id);
    }
    await this.costCentersRepository.update(center.id, {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.acceptsAssets !== undefined
        ? { acceptsAssets: dto.acceptsAssets }
        : {}),
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
    });
    await this.auditLogsRepository.record({
      action: AuditAction.CostCenterUpdated,
      entityType: COST_CENTER_ENTITY_TYPE,
      entityId: center.id,
      performedBy: actor.id,
      ipAddress: request.ip,
      userAgent: request.userAgent,
      changes: { ...dto },
    });
    return CostCenterResponseDto.from(await this.requireCenter(id));
  }

  async remove(id: string, actor: AuthenticatedUser, request: RequestMeta = NO_REQUEST): Promise<null> {
    const center = await this.requireCenter(id);
    await this.assertNoActiveAssets(center.id);
    await this.costCentersRepository.deactivate(center.id);
    await this.auditLogsRepository.record({
      action: AuditAction.CostCenterDeleted,
      entityType: COST_CENTER_ENTITY_TYPE,
      entityId: center.id,
      performedBy: actor.id,
      ipAddress: request.ip,
      userAgent: request.userAgent,
      changes: { externalCode: center.externalCode },
    });
    return null;
  }

  /** 406 COST_CENTER_HAS_ACTIVE_ASSETS con el número de activos (no dados de baja) en details[activeAssets]. */
  private async assertNoActiveAssets(costCenterId: string): Promise<void> {
    const assets = await this.costCentersRepository.countActiveAssets(costCenterId);
    if (assets > 0) {
      throw new ApiException(ErrorCode.CostCenterHasActiveAssets, undefined, [
        { field: 'activeAssets', message: String(assets) },
      ]);
    }
  }

  async sync(
    file: CsvUpload | undefined,
    actor: AuthenticatedUser,
  ): Promise<CostCenterSyncResponseDto> {
    if (!file || file.buffer.length === 0) {
      throw new ApiException(ErrorCode.InvalidCsv);
    }
    const rows = parseCostCenterCsv(file.buffer.toString('utf8'));
    if (rows.length === 0) {
      throw new ApiException(ErrorCode.InvalidCsv);
    }

    const syncedAt = new Date();
    let created = 0;
    let updated = 0;
    let reactivated = 0;
    const incomingCodes = new Set<string>();

    for (const row of rows) {
      incomingCodes.add(row.externalCode);
      let organizationalUnitId: string | null = null;
      if (row.organizationalUnitCode) {
        const unit = await this.costCentersRepository.findOrgUnitByCode(
          row.organizationalUnitCode,
        );
        if (!unit) {
          throw new ApiException(ErrorCode.ResourceNotFound);
        }
        organizationalUnitId = unit.id;
      }
      const existing = await this.costCentersRepository.findByExternalCode(
        row.externalCode,
      );
      if (!existing) {
        await this.costCentersRepository.insert({
          externalCode: row.externalCode,
          name: row.name,
          organizationalUnitId,
          parentId: null,
          acceptsAssets: row.acceptsAssets,
          isActive: true,
          syncSource: CostCenterSyncSource.ImportExcel,
          lastSyncedAt: syncedAt,
        });
        created += 1;
        continue;
      }
      const wasInactive = !existing.isActive;
      await this.costCentersRepository.update(existing.id, {
        name: row.name,
        organizationalUnitId,
        acceptsAssets: row.acceptsAssets,
        isActive: true,
        syncSource: CostCenterSyncSource.ImportExcel,
        lastSyncedAt: syncedAt,
      });
      updated += 1;
      if (wasInactive) {
        reactivated += 1;
      }
    }

    const current = await this.costCentersRepository.findAll({});
    let deactivated = 0;
    for (const center of current) {
      if (center.isActive && !incomingCodes.has(center.externalCode)) {
        await this.costCentersRepository.deactivate(center.id);
        deactivated += 1;
      }
    }

    const log = await this.costCentersRepository.insertSyncLog({
      filename: file.originalname,
      createdCount: created,
      updatedCount: updated,
      deactivatedCount: deactivated,
      reactivatedCount: reactivated,
      performedBy: actor.id,
    });
    await this.auditLogsRepository.record({
      action: AuditAction.CostCenterSynced,
      entityType: COST_CENTER_ENTITY_TYPE,
      entityId: log.id,
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
      changes: { created, updated, deactivated, reactivated },
    });
    return {
      id: log.id,
      filename: log.filename,
      created,
      updated,
      deactivated,
      reactivated,
    };
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
