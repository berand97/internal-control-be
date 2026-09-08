import { Inject, Injectable } from '@nestjs/common';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import { isUniqueViolation } from '../../../common/exceptions/postgres-error.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import { parseCostCenterCsv } from '../csv/parse-cost-center-csv.js';
import { CreateCostCenterDto } from '../dto/create-cost-center.dto.js';
import { QueryCostCentersDto } from '../dto/query-cost-centers.dto.js';
import { CostCenterSyncResponseDto } from '../dto/responses/cost-center-sync.response.dto.js';
import { CostCenterResponseDto } from '../dto/responses/cost-center.response.dto.js';
import { UpdateCostCenterDto } from '../dto/update-cost-center.dto.js';
import { CostCenterSyncSource } from '../enums/cost-center-sync-source.enum.js';
import type { CostCentersRepository } from '../repositories/cost-centers.repository.interface.js';

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
  ): Promise<CostCenterResponseDto> {
    if (dto.organizationalUnitId) {
      await this.requireOrgUnit(dto.organizationalUnitId);
    }
    if (dto.parentId) {
      await this.requireCenter(dto.parentId);
    }
    try {
      const center = await this.costCentersRepository.insert({
        externalCode: dto.externalCode,
        name: dto.name,
        organizationalUnitId: dto.organizationalUnitId ?? null,
        parentId: dto.parentId ?? null,
        acceptsAssets: dto.acceptsAssets ?? true,
        isActive: dto.isActive ?? true,
        syncSource: CostCenterSyncSource.Manual,
        lastSyncedAt: null,
      });
      await this.auditLogsRepository.record({
        action: AuditAction.CostCenterCreated,
        entityType: COST_CENTER_ENTITY_TYPE,
        entityId: center.id,
        performedBy: actor.id,
        ipAddress: null,
        userAgent: null,
        changes: { externalCode: center.externalCode },
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
  ): Promise<CostCenterResponseDto> {
    const center = await this.requireCenter(id);
    if (dto.organizationalUnitId) {
      await this.requireOrgUnit(dto.organizationalUnitId);
    }
    if (dto.parentId) {
      if (dto.parentId === center.id) {
        throw new ApiException(ErrorCode.InvalidState);
      }
      await this.requireCenter(dto.parentId);
    }
    if (dto.isActive === false && center.isActive) {
      const assets = await this.costCentersRepository.countActiveAssets(
        center.id,
      );
      if (assets > 0) {
        throw new ApiException(ErrorCode.CostCenterHasActiveAssets);
      }
    }
    await this.costCentersRepository.update(center.id, {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.organizationalUnitId !== undefined
        ? { organizationalUnitId: dto.organizationalUnitId }
        : {}),
      ...(dto.parentId !== undefined ? { parentId: dto.parentId } : {}),
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
      ipAddress: null,
      userAgent: null,
      changes: { ...dto },
    });
    return CostCenterResponseDto.from(await this.requireCenter(id));
  }

  async remove(id: string, actor: AuthenticatedUser): Promise<null> {
    const center = await this.requireCenter(id);
    const assets = await this.costCentersRepository.countActiveAssets(
      center.id,
    );
    if (assets > 0) {
      throw new ApiException(ErrorCode.CostCenterHasActiveAssets);
    }
    await this.costCentersRepository.deactivate(center.id);
    await this.auditLogsRepository.record({
      action: AuditAction.CostCenterDeleted,
      entityType: COST_CENTER_ENTITY_TYPE,
      entityId: center.id,
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
      changes: { externalCode: center.externalCode },
    });
    return null;
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
