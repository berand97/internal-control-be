import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AuditAction } from '../../auth/enums/audit-action.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import { MovementsService } from '../../movements/services/movements.service.js';
import { Asset } from '../entities/asset.entity.js';
import type { MovementType } from '../enums/movement-type.enum.js';
import type {
  AssetsRepository,
  UpdateAssetRecord,
} from '../repositories/assets.repository.interface.js';

export interface AssetMovementSpec {
  readonly type: MovementType;
  readonly reason: string | null;
  readonly documentReference: string | null;
  readonly executedAt?: Date;
  readonly requestedBy?: string | null;
  readonly metadata?: Record<string, unknown>;
  readonly initial?: boolean;
}

export interface AssetChange {
  readonly assetId: string;
  readonly actorId: string;
  readonly patch: UpdateAssetRecord;
  readonly movement?: AssetMovementSpec;
  readonly audit?: {
    readonly action: AuditAction;
    readonly changes?: Record<string, unknown>;
  };
  readonly guard?: (current: Asset) => void;
  readonly alsoWrite?: (manager: EntityManager, current: Asset) => Promise<void>;
}

const PHYSICAL_CONDITION_UNKNOWN = 'PHYSICAL_CONDITION_UNKNOWN';

@Injectable()
export class AssetStateService {
  constructor(
    private readonly dataSource: DataSource,
    @Inject('AssetsRepository')
    private readonly assetsRepository: AssetsRepository,
    private readonly movementsService: MovementsService,
    @Inject('AuditLogsRepository')
    private readonly auditLogsRepository: AuditLogsRepository,
  ) {}

  apply(change: AssetChange, manager?: EntityManager): Promise<Asset> {
    return manager
      ? this.applyWithin(change, manager)
      : this.dataSource.transaction((own) => this.applyWithin(change, own));
  }

  private async applyWithin(
    change: AssetChange,
    manager: EntityManager,
  ): Promise<Asset> {
    const assets = manager.getRepository(Asset);
    const current = await assets.findOne({
      where: { id: change.assetId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!current) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    change.guard?.(current);

    const verifiesCondition =
      change.patch.physicalCondition !== undefined &&
      change.patch.physicalCondition !== null &&
      current.dataQualityFlags.includes(PHYSICAL_CONDITION_UNKNOWN);
    const patch = verifiesCondition
      ? {
          ...change.patch,
          dataQualityFlags: current.dataQualityFlags.filter((flag) => flag !== PHYSICAL_CONDITION_UNKNOWN),
        }
      : change.patch;
    await this.assetsRepository.update(
      current.id,
      { ...patch, updatedBy: change.actorId },
      manager,
    );
    const next = { ...current, ...definedOnly(patch) };

    if (change.movement) {
      const from = change.movement.initial ? null : current;
      await this.movementsService.record(
        {
          assetId: current.id,
          movementType: change.movement.type,
          fromCostCenterId: from?.costCenterId ?? null,
          fromLocationId: from?.locationId ?? null,
          fromResponsibleId: from?.responsibleId ?? null,
          fromOperationalStatus: from?.operationalStatus ?? null,
          fromPhysicalCondition: from?.physicalCondition ?? null,
          toCostCenterId: next.costCenterId,
          toLocationId: next.locationId,
          toResponsibleId: next.responsibleId,
          toOperationalStatus: next.operationalStatus,
          toPhysicalCondition: next.physicalCondition,
          requestedBy: change.movement.requestedBy ?? change.actorId,
          authorizedBy: change.actorId,
          reason: change.movement.reason,
          documentReference: change.movement.documentReference,
          ...(change.movement.executedAt
            ? { executedAt: change.movement.executedAt }
            : {}),
          ...(change.movement.metadata
            ? { metadata: change.movement.metadata }
            : {}),
        },
        manager,
      );
    }

    await change.alsoWrite?.(manager, current);

    if (change.audit) {
      await this.auditLogsRepository.record(
        {
          action: change.audit.action,
          entityType: 'ASSET',
          entityId: current.id,
          performedBy: change.actorId,
          ipAddress: null,
          userAgent: null,
          ...(change.audit.changes ? { changes: change.audit.changes } : {}),
        },
        manager,
      );
    }

    const updated = await assets.findOne({ where: { id: current.id } });
    if (!updated) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return updated;
  }
}

const definedOnly = (patch: UpdateAssetRecord): Partial<Asset> =>
  Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<Asset>;
