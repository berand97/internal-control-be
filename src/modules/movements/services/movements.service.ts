import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { type EntityManager, type QueryDeepPartialEntity, Repository } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AppConfig } from '../../../config/configuration.js';
import { AssetMovement } from '../../assets/entities/asset-movement.entity.js';
import type { CreateMovementRecord } from '../../assets/repositories/assets.repository.interface.js';
import type { MovementType } from '../../assets/enums/movement-type.enum.js';
import {
  canonicalMovementPayload,
  SIGNATURE_VERSION,
  signMovement,
} from '../crypto/sign-movement.js';
import { MovementVerificationLog } from '../entities/movement-verification-log.entity.js';

/** Filas por INSERT en recordInitial: ~23 columnas por fila, lejos del límite de 65.535 parámetros. */
const INITIAL_INSERT_CHUNK = 1000;

export interface RecordMovementInput extends CreateMovementRecord {
  readonly loanId?: string | null;
  readonly metadata?: Record<string, unknown> | null;
  readonly executedAt?: Date;
}

export type ChainFailureReason =
  | 'UNSIGNED'
  | 'LEGACY_SCHEME'
  | 'SIGNATURE_MISMATCH'
  | 'BROKEN_LINK'
  | 'FORK'
  | 'NOT_A_SINGLE_CHAIN';

export interface ChainFailure {
  readonly assetId: string;
  readonly movementId: string | null;
  readonly reason: ChainFailureReason;
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

  async record(
    input: RecordMovementInput,
    manager?: EntityManager,
  ): Promise<AssetMovement> {
    const movements = manager?.getRepository(AssetMovement) ?? this.movements;
    const previous = await movements
      .createQueryBuilder('m')
      .where('m.asset_id = :assetId', { assetId: input.assetId })
      .andWhere(
        'NOT EXISTS (SELECT 1 FROM asset_movement n WHERE n.previous_movement_id = m.id)',
      )
      .orderBy('m.created_at', 'DESC')
      .getOne();
    return movements.save(this.signed(movements, input, previous?.id ?? null, new Date()));
  }

  /**
   * Registro inicial por conjuntos: el primer movimiento de cada activo (previous_movement_id NULL), firmado con el
   * mismo esquema que record() (mismo constructor signed(), mismos campos, misma serialización, SIGNATURE_VERSION) y
   * escrito con INSERT por lotes. Solo aplica a activos sin movimientos: si alguno ya tiene, lanza sin escribir.
   * Quien llama debe tener bloqueados los activos (FOR UPDATE), igual que AssetStateService antes de record().
   */
  async recordInitial(
    inputs: ReadonlyArray<RecordMovementInput>,
    manager: EntityManager,
  ): Promise<number> {
    if (inputs.length === 0) {
      return 0;
    }
    const [existing] = (await manager.query(
      'SELECT asset_id FROM asset_movement WHERE asset_id = ANY($1::uuid[]) LIMIT 1',
      [inputs.map((input) => input.assetId)],
    )) as Array<{ asset_id: string }>;
    if (existing) {
      throw new Error('El registro inicial solo aplica a activos sin movimientos');
    }
    const movements = manager.getRepository(AssetMovement);
    const now = new Date();
    const entities = inputs.map((input) => this.signed(movements, input, null, now));
    for (let start = 0; start < entities.length; start += INITIAL_INSERT_CHUNK) {
      await movements
        .createQueryBuilder()
        .insert()
        .into(AssetMovement)
        .values(entities.slice(start, start + INITIAL_INSERT_CHUNK) as QueryDeepPartialEntity<AssetMovement>[])
        .updateEntity(false)
        .execute();
    }
    return entities.length;
  }

  private signed(
    movements: Repository<AssetMovement>,
    input: RecordMovementInput,
    previousMovementId: string | null,
    now: Date,
  ): AssetMovement {
    const entity = movements.create({
      ...input,
      loanId: input.loanId ?? null,
      metadata: {
        ...(input.metadata ?? {}),
        signedAt: now.toISOString(),
        signatureVersion: SIGNATURE_VERSION,
      },
      previousMovementId,
      executedAt: input.executedAt ?? now,
      createdAt: now,
    });
    entity.eventSignature = this.signatureOf(entity);
    return entity;
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
    const valid = this.signatureFailure(movement) === null;
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
      SELECT asset_id
      FROM (SELECT DISTINCT asset_id FROM asset_movement) assets
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
    const failures: ChainFailure[] = [];
    for (const assetId of assetIds) {
      failures.push(...(await this.verifyAssetChain(assetId)));
    }
    const log = this.verificationLogs.create({
      checkedAt: new Date(),
      assetsChecked: assetIds.length,
      failures: failures.length,
      details: failures.length > 0 ? failures : null,
    });
    return this.verificationLogs.save(log);
  }

  async verifyAssetChain(assetId: string): Promise<ReadonlyArray<ChainFailure>> {
    const items = await this.movements.find({
      where: { assetId },
      order: { createdAt: 'ASC' },
    });
    const failures: ChainFailure[] = [];
    const byId = new Map(items.map((item) => [item.id, item]));
    const successors = new Map<string | null, AssetMovement[]>();
    for (const item of items) {
      const reason = this.signatureFailure(item);
      if (reason) {
        failures.push({ assetId, movementId: item.id, reason });
      }
      if (item.previousMovementId && !byId.has(item.previousMovementId)) {
        failures.push({ assetId, movementId: item.id, reason: 'BROKEN_LINK' });
      }
      const key = item.previousMovementId;
      successors.set(key, [...(successors.get(key) ?? []), item]);
    }
    for (const [previousId, next] of successors) {
      if (previousId !== null && next.length > 1) {
        for (const item of next) {
          failures.push({ assetId, movementId: item.id, reason: 'FORK' });
        }
      }
    }
    const heads = successors.get(null) ?? [];
    let walked = 0;
    let cursor = heads.length === 1 ? heads[0] : undefined;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      walked += 1;
      const next = successors.get(cursor.id);
      cursor = next?.length === 1 ? next[0] : undefined;
    }
    if (items.length > 0 && (heads.length !== 1 || walked !== items.length)) {
      failures.push({ assetId, movementId: null, reason: 'NOT_A_SINGLE_CHAIN' });
    }
    return failures;
  }

  private signatureFailure(movement: AssetMovement): ChainFailureReason | null {
    if (!movement.eventSignature) {
      return 'UNSIGNED';
    }
    if (movement.metadata?.['signatureVersion'] !== SIGNATURE_VERSION) {
      return 'LEGACY_SCHEME';
    }
    return this.signatureOf(movement) === movement.eventSignature
      ? null
      : 'SIGNATURE_MISMATCH';
  }

  private signatureOf(movement: AssetMovement): string {
    const canonical = canonicalMovementPayload({
      assetId: movement.assetId,
      movementType: movement.movementType,
      executedAt: movement.executedAt,
      requestedBy: movement.requestedBy ?? null,
      authorizedBy: movement.authorizedBy ?? null,
      from: {
        costCenterId: movement.fromCostCenterId ?? null,
        locationId: movement.fromLocationId ?? null,
        responsibleId: movement.fromResponsibleId ?? null,
        operationalStatus: movement.fromOperationalStatus ?? null,
        physicalCondition: movement.fromPhysicalCondition ?? null,
      },
      to: {
        costCenterId: movement.toCostCenterId ?? null,
        locationId: movement.toLocationId ?? null,
        responsibleId: movement.toResponsibleId ?? null,
        operationalStatus: movement.toOperationalStatus ?? null,
        physicalCondition: movement.toPhysicalCondition ?? null,
      },
      reason: movement.reason ?? null,
      documentReference: movement.documentReference ?? null,
      loanId: movement.loanId ?? null,
      previousMovementId: movement.previousMovementId ?? null,
      metadata: movement.metadata ?? {},
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
