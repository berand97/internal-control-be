import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AppConfig } from '../../../config/configuration.js';
import { AssetMovement } from '../../assets/entities/asset-movement.entity.js';
import type { CreateMovementRecord } from '../../assets/repositories/assets.repository.interface.js';
import type { MovementType } from '../../assets/enums/movement-type.enum.js';
import {
  canonicalMovementPayload,
  signMovement,
  stableJson,
} from '../crypto/sign-movement.js';
import { MovementVerificationLog } from '../entities/movement-verification-log.entity.js';

export interface RecordMovementInput extends CreateMovementRecord {
  readonly loanId?: string | null;
  readonly metadata?: Record<string, unknown> | null;
}

export interface MovementListQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly type?: MovementType;
  readonly fromDate?: string;
  readonly toDate?: string;
  readonly performedBy?: string;
  readonly costCenterId?: string;
  readonly assetId?: string;
}

@Injectable()
export class MovementsService {
  constructor(
    @InjectRepository(AssetMovement)
    private readonly movements: Repository<AssetMovement>,
    @InjectRepository(MovementVerificationLog)
    private readonly verificationLogs: Repository<MovementVerificationLog>,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async record(input: RecordMovementInput): Promise<AssetMovement> {
    const previous = await this.movements.findOne({
      where: { assetId: input.assetId },
      order: { executedAt: 'DESC', createdAt: 'DESC' },
    });
    const now = new Date();
    const timestamp = now.toISOString();
    const previousValues = stableJson({
      costCenterId: input.fromCostCenterId,
      locationId: input.fromLocationId,
      responsibleId: input.fromResponsibleId,
      operationalStatus: input.fromOperationalStatus,
      physicalCondition: input.fromPhysicalCondition,
    });
    const newValues = stableJson({
      costCenterId: input.toCostCenterId,
      locationId: input.toLocationId,
      responsibleId: input.toResponsibleId,
      operationalStatus: input.toOperationalStatus,
      physicalCondition: input.toPhysicalCondition,
    });
    const canonical = canonicalMovementPayload({
      assetId: input.assetId,
      type: input.movementType,
      timestamp,
      performedBy: input.authorizedBy ?? input.requestedBy ?? '',
      previousValues,
      newValues,
      previousMovementId: previous?.id ?? '',
    });
    const entity = this.movements.create({
      ...input,
      loanId: input.loanId ?? null,
      metadata: { ...(input.metadata ?? {}), signedAt: timestamp },
      previousMovementId: previous?.id ?? null,
      eventSignature: signMovement(this.secret(), canonical),
      executedAt: now,
      createdAt: now,
    });
    return this.movements.save(entity);
  }

  async list(query: MovementListQuery): Promise<{
    readonly items: ReadonlyArray<AssetMovement>;
    readonly total: number;
    readonly page: number;
    readonly pageSize: number;
    readonly hasNext: boolean;
  }> {
    const qb = this.movements.createQueryBuilder('m');
    if (query.assetId) {
      qb.andWhere('m.asset_id = :assetId', { assetId: query.assetId });
    }
    if (query.type) {
      qb.andWhere('m.movement_type = :type', { type: query.type });
    }
    if (query.fromDate) {
      qb.andWhere('m.executed_at >= :fromDate', { fromDate: query.fromDate });
    }
    if (query.toDate) {
      qb.andWhere('m.executed_at <= :toDate', { toDate: query.toDate });
    }
    if (query.performedBy) {
      qb.andWhere('m.authorized_by = :performedBy', {
        performedBy: query.performedBy,
      });
    }
    if (query.costCenterId) {
      qb.andWhere(
        '(m.from_cost_center_id = :costCenterId OR m.to_cost_center_id = :costCenterId)',
        { costCenterId: query.costCenterId },
      );
    }
    const total = await qb.getCount();
    const items = await qb
      .orderBy('m.executed_at', 'DESC')
      .skip((query.page - 1) * query.pageSize)
      .take(query.pageSize)
      .getMany();
    return {
      items,
      total,
      page: query.page,
      pageSize: query.pageSize,
      hasNext: query.page * query.pageSize < total,
    };
  }

  async verify(id: string): Promise<{
    readonly id: string;
    readonly valid: boolean;
    readonly unsigned: boolean;
  }> {
    const movement = await this.movements.findOne({ where: { id } });
    if (!movement) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    if (!movement.eventSignature) {
      return { id: movement.id, valid: false, unsigned: true };
    }
    const valid = this.signatureOf(movement) === movement.eventSignature;
    if (!valid) {
      throw new ApiException(ErrorCode.MovementTampered);
    }
    return { id: movement.id, valid: true, unsigned: false };
  }

  async exportCsv(assetId: string): Promise<string> {
    const items = await this.movements.find({
      where: { assetId },
      order: { executedAt: 'DESC' },
    });
    const header = 'id,type,executedAt,reason,documentReference,fromStatus,toStatus';
    const rows = items.map((item) =>
      [
        item.id,
        item.movementType,
        item.executedAt.toISOString(),
        csvCell(item.reason),
        csvCell(item.documentReference),
        item.fromOperationalStatus ?? '',
        item.toOperationalStatus ?? '',
      ].join(','),
    );
    return [header, ...rows].join('\n');
  }

  async verifySample(limit = 100): Promise<MovementVerificationLog> {
    const ids: unknown = await this.movements.query(
      `
      SELECT DISTINCT asset_id
      FROM asset_movement
      ORDER BY random()
      LIMIT $1
      `,
      [limit],
    );
    const assetIds = Array.isArray(ids)
      ? ids
          .map((row) =>
            typeof row === 'object' &&
            row !== null &&
            typeof (row as { asset_id?: unknown }).asset_id === 'string'
              ? (row as { asset_id: string }).asset_id
              : null,
          )
          .filter((item): item is string => item !== null)
      : [];
    const failures: Array<{ assetId: string; movementId: string }> = [];
    for (const assetId of assetIds) {
      const latest = await this.movements.findOne({
        where: { assetId },
        order: { executedAt: 'DESC' },
      });
      if (!latest?.eventSignature) {
        continue;
      }
      if (this.signatureOf(latest) !== latest.eventSignature) {
        failures.push({ assetId, movementId: latest.id });
      }
    }
    const log = this.verificationLogs.create({
      checkedAt: new Date(),
      assetsChecked: assetIds.length,
      failures: failures.length,
      details: failures.length > 0 ? failures : null,
    });
    return this.verificationLogs.save(log);
  }

  private signatureOf(movement: AssetMovement): string {
    const signedAt =
      typeof movement.metadata?.['signedAt'] === 'string'
        ? movement.metadata['signedAt']
        : movement.executedAt.toISOString();
    const canonical = canonicalMovementPayload({
      assetId: movement.assetId,
      type: movement.movementType,
      timestamp: signedAt,
      performedBy: movement.authorizedBy ?? movement.requestedBy ?? '',
      previousValues: stableJson({
        costCenterId: movement.fromCostCenterId,
        locationId: movement.fromLocationId,
        responsibleId: movement.fromResponsibleId,
        operationalStatus: movement.fromOperationalStatus,
        physicalCondition: movement.fromPhysicalCondition,
      }),
      newValues: stableJson({
        costCenterId: movement.toCostCenterId,
        locationId: movement.toLocationId,
        responsibleId: movement.toResponsibleId,
        operationalStatus: movement.toOperationalStatus,
        physicalCondition: movement.toPhysicalCondition,
      }),
      previousMovementId: movement.previousMovementId ?? '',
    });
    return signMovement(this.secret(), canonical);
  }

  private secret(): string {
    return this.config.getOrThrow('movementSigningSecret', { infer: true });
  }
}

const csvCell = (value: string | null): string => {
  if (!value) {
    return '';
  }
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
};
