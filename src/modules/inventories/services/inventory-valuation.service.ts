import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { bogotaDate } from '../domain/inventory-schedule.js';
import {
  type AssetIdentity,
  type AssetValuation,
  type ReconciliationBasis,
  valuationOf,
} from '../domain/inventory-valuation.js';
import type { PhysicalInventory } from '../entities/physical-inventory.entity.js';
import type { PhysicalInventoryItem } from '../entities/physical-inventory-item.entity.js';
import { InventoryCatalogsService } from './inventory-catalogs.service.js';
import type { ItemViewContext } from './inventory-item-view.js';
import { loadResponsibleNames } from './inventory-summary.js';

interface CutRow {
  readonly id: string;
  readonly cut_date: string;
  readonly source_label: string;
}

interface ValuationRow {
  readonly id: string;
  readonly price: string | null;
  readonly cut_value: string | null;
  readonly depreciation_value: string | null;
}

const toNumber = (value: string | null): number | null => (value === null ? null : Number(value));

/**
 * Valor en libros y precio de compra de los activos de una toma, y la base de conciliación (valuationOf).
 * Solo lee asset_depreciation: funciona con la funcionalidad de depreciación apagada.
 */
@Injectable()
export class InventoryValuationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly catalogs: InventoryCatalogsService,
  ) {}

  async basis(inventory: PhysicalInventory, manager?: EntityManager): Promise<ReconciliationBasis> {
    const cut = inventory.accountingCutId ? await this.cut(inventory.accountingCutId, manager) : undefined;
    const snapshotDate = inventory.actualStartDate ?? null;
    return {
      kind: cut ? 'ACCOUNTING_CUT' : 'SYSTEM_SNAPSHOT',
      cutId: cut?.id ?? null,
      cutDate: cut?.cut_date ?? null,
      sourceLabel: cut?.source_label ?? null,
      snapshotAt: inventory.snapshotTakenAt ?? null,
      snapshotDate,
      valuationDate: cut?.cut_date ?? snapshotDate ?? bogotaDate(new Date()),
    };
  }

  async valuations(
    inventory: PhysicalInventory,
    assetIds: ReadonlyArray<string>,
    manager?: EntityManager,
    basis?: ReconciliationBasis,
  ): Promise<Map<string, AssetValuation>> {
    const ids = [...new Set(assetIds)];
    if (ids.length === 0) {
      return new Map();
    }
    const { cutId, valuationDate } = basis ?? (await this.basis(inventory, manager));
    const [year = 0, month = 0] = valuationDate.split('-').map(Number);
    const rows = (await (manager ?? this.dataSource).query(
      `
      SELECT a.id, a.acquisition_price::text AS price, l.book_value::text AS cut_value,
             d.book_value::text AS depreciation_value
      FROM unnest($1::uuid[]) AS x(id)
      JOIN asset a ON a.id = x.id
      LEFT JOIN accounting_cut_line l ON l.cut_id = $2::uuid AND l.asset_id = a.id
      LEFT JOIN LATERAL (
        SELECT dep.book_value FROM asset_depreciation dep
        WHERE dep.asset_id = a.id AND (dep.period_year * 100 + dep.period_month) <= $3
        ORDER BY dep.period_year DESC, dep.period_month DESC
        LIMIT 1
      ) d ON TRUE
      `,
      [ids, cutId, year * 100 + month],
    )) as ValuationRow[];
    return new Map(
      rows.map((row) => [
        row.id,
        valuationOf(toNumber(row.price), toNumber(row.cut_value), toNumber(row.depreciation_value)),
      ]),
    );
  }

  /** Contexto de serialización de ítems de la toma: catálogos y valoración de sus activos. */
  async viewContext(
    inventory: PhysicalInventory,
    items: ReadonlyArray<PhysicalInventoryItem>,
    manager?: EntityManager,
  ): Promise<ItemViewContext> {
    const base = await this.catalogs.viewContext();
    const assetIds = items.flatMap((item) => [item.assetId, item.resolvedAssetId]).filter((id): id is string => !!id);
    return {
      ...base,
      valuations: await this.valuations(inventory, assetIds, manager),
      assets: await this.identities(assetIds, manager),
      userNames: await loadResponsibleNames(
        manager ?? this.dataSource,
        items.flatMap((item) => [item.verifiedBy, item.resolvedBy]),
      ),
    };
  }

  /** Código (visible > heredado > interno), descripción y código heredado (o de barras) de cada activo. */
  async identities(assetIds: ReadonlyArray<string>, manager?: EntityManager): Promise<Map<string, AssetIdentity>> {
    const ids = [...new Set(assetIds)];
    if (ids.length === 0) {
      return new Map();
    }
    const rows = (await (manager ?? this.dataSource).query(
      `
      SELECT a.id, a.description,
             coalesce(visible.value, legacy.value, a.internal_code) AS code,
             coalesce(legacy.value, a.barcode) AS legacy_code
      FROM unnest($1::uuid[]) AS x(id)
      JOIN asset a ON a.id = x.id
      LEFT JOIN LATERAL (
        SELECT i.value FROM asset_identifier i
        WHERE i.asset_id = a.id AND i.identifier_type = 'VISIBLE_CODE' AND i.valid_to IS NULL LIMIT 1
      ) visible ON TRUE
      LEFT JOIN LATERAL (
        SELECT i.value FROM asset_identifier i
        WHERE i.asset_id = a.id AND i.identifier_type = 'LEGACY_CODE' AND i.valid_to IS NULL ORDER BY i.created_at LIMIT 1
      ) legacy ON TRUE
      `,
      [ids],
    )) as Array<{ id: string; description: string; code: string; legacy_code: string | null }>;
    return new Map(
      rows.map((row) => [row.id, { code: row.code, description: row.description, legacyCode: row.legacy_code }]),
    );
  }

  private async cut(id: string, manager?: EntityManager): Promise<CutRow | undefined> {
    const [row] = (await (manager ?? this.dataSource).query(
      `SELECT id, to_char(cut_date, 'YYYY-MM-DD') AS cut_date, source_label FROM accounting_cut WHERE id = $1`,
      [id],
    )) as CutRow[];
    return row;
  }
}
