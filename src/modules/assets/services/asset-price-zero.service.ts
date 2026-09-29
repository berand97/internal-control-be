import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import { costCenterFilter, type ReadableCostCenterScope } from '../../roles/services/cost-center-scope.js';
import type {
  CreatePriceZeroReasonDto,
  QueryPriceZeroAssetsDto,
  SetPriceZeroReasonDto,
  UpdatePriceZeroReasonDto,
} from '../dto/price-zero.dto.js';
import type { PriceZeroAssetDto, PriceZeroAssetListDto } from '../dto/responses/price-zero.response.dto.js';
import { AssetPriceZeroReason } from '../entities/asset-price-zero-reason.entity.js';
import type { OperationalStatus } from '../enums/operational-status.enum.js';

/** Marca de calidad de un precio de compra cero (la pone la importación y el trigger trg_asset_price_zero_flag). */
export const PRICE_ZERO_FLAG = 'PRICE_ZERO';

const CATALOG_ENTITY = 'ASSET_PRICE_ZERO_REASON';

interface PriceZeroRow {
  id: string;
  internal_code: string;
  description: string;
  acquisition_date: string | null;
  operational_status: OperationalStatus;
  cost_center_id: string | null;
  cost_center_code: string | null;
  cost_center_name: string | null;
  location_id: string | null;
  location_code: string | null;
  location_name: string | null;
  reason_id: string | null;
  reason_label: string | null;
  reason_active: boolean | null;
  note: string | null;
  classified_at: Date | null;
  classified_by: string | null;
  classified_by_name: string | null;
}

const ROW_SELECT = `
  SELECT a.id, a.internal_code, a.description, a.acquisition_date::text AS acquisition_date, a.operational_status,
         cc.id AS cost_center_id, cc.external_code AS cost_center_code, cc.name AS cost_center_name,
         l.id AS location_id, l.code AS location_code, l.name AS location_name,
         r.id AS reason_id, r.label AS reason_label, r.is_active AS reason_active,
         c.note, c.classified_at, c.classified_by,
         nullif(trim(concat_ws(' ', p.first_name, p.last_name)), '') AS classified_by_name
  FROM asset a
  LEFT JOIN cost_center cc ON cc.id = a.current_cost_center_id
  LEFT JOIN location l ON l.id = a.current_location_id
  LEFT JOIN asset_price_zero_classification c ON c.asset_id = a.id
  LEFT JOIN asset_price_zero_reason r ON r.id = c.reason_id
  LEFT JOIN app_user u ON u.id = c.classified_by
  LEFT JOIN person p ON p.id = u.person_id`;

/**
 * Activos con precio de compra cero: se cargan y quedan marcados (PRICE_ZERO), sin bloquear la importación. Control
 * Interno los clasifica con un motivo de un catálogo administrable que nace vacío; registrar el motivo no toca el
 * precio. Si el precio deja de ser 0, el trigger quita la marca y el activo sale de la lista (su motivo queda como
 * historia). La lista respeta el alcance de lectura de activos (asset:read:global / asset:read:org_unit).
 */
@Injectable()
export class AssetPriceZeroService {
  constructor(
    @InjectRepository(AssetPriceZeroReason)
    private readonly reasons: Repository<AssetPriceZeroReason>,
    private readonly dataSource: DataSource,
    @Inject('AuditLogsRepository')
    private readonly auditLogs: AuditLogsRepository,
  ) {}

  // ---------- Catálogo de motivos ----------

  async listReasons() {
    const rows = await this.reasons.find({ order: { sortOrder: 'ASC', label: 'ASC' } });
    const used = await this.usedReasonIds();
    return rows.map((row) => this.toReason(row, used.has(row.id)));
  }

  async createReason(dto: CreatePriceZeroReasonDto, actor: AuthenticatedUser) {
    await this.assertLabelFree(dto.label, null);
    const saved = await this.reasons.save(
      this.reasons.create({ label: dto.label, isActive: dto.isActive ?? true, sortOrder: dto.sortOrder ?? 0 }),
    );
    await this.auditCatalog(actor, saved.id, { op: 'CREATE', label: saved.label });
    return this.toReason(await this.requireReason(saved.id), false);
  }

  async updateReason(id: string, dto: UpdatePriceZeroReasonDto, actor: AuthenticatedUser) {
    const reason = await this.requireReason(id);
    if (dto.label !== undefined) {
      await this.assertLabelFree(dto.label, reason.id);
    }
    const patch: Partial<AssetPriceZeroReason> = {
      ...(dto.label !== undefined ? { label: dto.label } : {}),
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
    };
    await this.reasons.update({ id: reason.id }, { ...patch, updatedAt: new Date() });
    await this.auditCatalog(actor, reason.id, { op: 'UPDATE', fields: Object.keys(patch) });
    return this.toReason(await this.requireReason(reason.id), (await this.usedReasonIds()).has(reason.id));
  }

  async deleteReason(id: string, actor: AuthenticatedUser) {
    const reason = await this.requireReason(id);
    if ((await this.usedReasonIds()).has(reason.id)) {
      throw new ApiException(ErrorCode.AssetPriceZeroReasonInUse);
    }
    await this.reasons.delete({ id: reason.id });
    await this.auditCatalog(actor, reason.id, { op: 'DELETE', label: reason.label });
    return { deleted: true };
  }

  // ---------- Lista de trabajo ----------

  async list(query: QueryPriceZeroAssetsDto, scope: ReadableCostCenterScope): Promise<PriceZeroAssetListDto> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const base = [
      `$1::text = ANY(a.data_quality_flags)`,
      `($2::uuid[] IS NULL OR a.current_cost_center_id = ANY($2::uuid[]))`,
      `($3::uuid IS NULL OR a.current_cost_center_id = $3::uuid)`,
    ];
    const filters = [
      ...base,
      `($4::boolean IS NULL OR (c.asset_id IS NOT NULL) = $4::boolean)`,
      `($5::uuid IS NULL OR c.reason_id = $5::uuid)`,
      `($6::text IS NULL OR a.internal_code ILIKE $6::text OR a.description ILIKE $6::text)`,
    ];
    const scopeIds = costCenterFilter(scope);
    const params = [
      PRICE_ZERO_FLAG,
      scopeIds ? [...scopeIds] : null,
      query.costCenterId ?? null,
      query.classified ?? null,
      query.reasonId ?? null,
      query.q ? `%${query.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%` : null,
    ];
    const rows = (await this.dataSource.query(
      `${ROW_SELECT}
       WHERE ${filters.join(' AND ')}
       ORDER BY a.internal_code, a.id
       LIMIT $7 OFFSET $8`,
      [...params, pageSize, (page - 1) * pageSize],
    )) as PriceZeroRow[];
    const [counts] = (await this.dataSource.query(
      `SELECT count(*) FILTER (WHERE ${filters.slice(base.length).join(' AND ')})::int AS total,
              count(*)::int AS all_total,
              count(c.asset_id)::int AS classified
       FROM asset a LEFT JOIN asset_price_zero_classification c ON c.asset_id = a.id
       WHERE ${base.join(' AND ')}`,
      params,
    )) as Array<{ total: number; all_total: number; classified: number }>;
    const total = counts?.total ?? 0;
    return {
      items: rows.map((row) => this.toAsset(row)),
      page,
      pageSize,
      total,
      hasNext: page * pageSize < total,
      summary: {
        total: counts?.all_total ?? 0,
        classified: counts?.classified ?? 0,
        unclassified: (counts?.all_total ?? 0) - (counts?.classified ?? 0),
      },
    };
  }

  /**
   * Registra (o cambia) el motivo del precio cero de un activo, sin tocar el precio. 404 si el activo no existe o está
   * fuera del alcance de lectura; 406 ASSET_PRICE_NOT_ZERO si no tiene la marca PRICE_ZERO; 406
   * ASSET_PRICE_ZERO_REASON_UNAVAILABLE si el motivo no existe o está inactivo. Auditado (sin el texto de la nota).
   */
  async setReason(
    assetId: string,
    dto: SetPriceZeroReasonDto,
    scope: ReadableCostCenterScope,
    actor: AuthenticatedUser,
  ): Promise<PriceZeroAssetDto> {
    const scopeIds = costCenterFilter(scope);
    await this.dataSource.transaction(async (manager) => {
      const [asset] = (await manager.query(
        `SELECT id, $3::text = ANY(data_quality_flags) AS price_zero FROM asset
         WHERE id = $1 AND ($2::uuid[] IS NULL OR current_cost_center_id = ANY($2::uuid[]))
         FOR UPDATE`,
        [assetId, scopeIds ? [...scopeIds] : null, PRICE_ZERO_FLAG],
      )) as Array<{ id: string; price_zero: boolean }>;
      if (!asset) {
        throw new ApiException(ErrorCode.ResourceNotFound);
      }
      if (!asset.price_zero) {
        throw new ApiException(ErrorCode.AssetPriceNotZero);
      }
      const [reason] = (await manager.query('SELECT id FROM asset_price_zero_reason WHERE id = $1 AND is_active', [
        dto.reasonId,
      ])) as unknown[];
      if (!reason) {
        throw new ApiException(ErrorCode.AssetPriceZeroReasonUnavailable);
      }
      const [previous] = (await manager.query(
        'SELECT reason_id, note FROM asset_price_zero_classification WHERE asset_id = $1',
        [assetId],
      )) as Array<{ reason_id: string; note: string | null }>;
      const note = dto.note?.trim() || null;
      await manager.query(
        `INSERT INTO asset_price_zero_classification (asset_id, reason_id, note, classified_at, classified_by)
         VALUES ($1, $2, $3, NOW(), $4)
         ON CONFLICT (asset_id) DO UPDATE
           SET reason_id = EXCLUDED.reason_id, note = EXCLUDED.note, classified_at = EXCLUDED.classified_at,
               classified_by = EXCLUDED.classified_by`,
        [assetId, dto.reasonId, note, actor.id],
      );
      await this.auditLogs.record(
        {
          action: AuditAction.PriceZeroReasonSet,
          entityType: 'ASSET',
          entityId: assetId,
          performedBy: actor.id,
          ipAddress: null,
          userAgent: null,
          // Sin el texto de la nota (texto libre): solo si cambió.
          changes: {
            reasonId: { from: previous?.reason_id ?? null, to: dto.reasonId },
            noteChanged: (previous?.note ?? null) !== note,
          },
        },
        manager,
      );
    });
    const [row] = (await this.dataSource.query(`${ROW_SELECT} WHERE a.id = $1`, [assetId])) as PriceZeroRow[];
    return this.toAsset(row as PriceZeroRow);
  }

  private toAsset(row: PriceZeroRow): PriceZeroAssetDto {
    return {
      id: row.id,
      internalCode: row.internal_code,
      description: row.description,
      acquisitionDate: row.acquisition_date,
      operationalStatus: row.operational_status,
      costCenter: row.cost_center_id
        ? { id: row.cost_center_id, code: row.cost_center_code ?? '', name: row.cost_center_name ?? '' }
        : null,
      location: row.location_id
        ? { id: row.location_id, code: row.location_code ?? '', name: row.location_name ?? '' }
        : null,
      reason: row.reason_id
        ? { id: row.reason_id, label: row.reason_label ?? '', isActive: row.reason_active === true }
        : null,
      note: row.note,
      classifiedAt: row.classified_at ? new Date(row.classified_at).toISOString() : null,
      classifiedBy: row.classified_by ? { userId: row.classified_by, name: row.classified_by_name ?? '' } : null,
    };
  }

  private async requireReason(id: string): Promise<AssetPriceZeroReason> {
    const reason = await this.reasons.findOne({ where: { id } });
    if (!reason) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return reason;
  }

  private async assertLabelFree(label: string, exceptId: string | null): Promise<void> {
    const rows = (await this.dataSource.query(
      `SELECT id FROM asset_price_zero_reason WHERE lower(btrim(label)) = lower(btrim($1)) AND ($2::uuid IS NULL OR id <> $2)`,
      [label, exceptId],
    )) as unknown[];
    if (rows.length > 0) {
      throw new ApiException(ErrorCode.AssetPriceZeroReasonExists);
    }
  }

  private async usedReasonIds(): Promise<ReadonlySet<string>> {
    const rows = (await this.dataSource.query(
      'SELECT DISTINCT reason_id::text AS id FROM asset_price_zero_classification',
    )) as Array<{ id: string }>;
    return new Set(rows.map((row) => row.id));
  }

  private toReason(row: AssetPriceZeroReason, inUse: boolean) {
    return {
      id: row.id,
      label: row.label,
      isActive: row.isActive,
      sortOrder: row.sortOrder,
      inUse,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private auditCatalog(actor: AuthenticatedUser, id: string, changes: Record<string, unknown>): Promise<void> {
    return this.auditLogs.record({
      action: AuditAction.PriceZeroCatalogChanged,
      entityType: CATALOG_ENTITY,
      entityId: id,
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
      changes,
    });
  }
}
