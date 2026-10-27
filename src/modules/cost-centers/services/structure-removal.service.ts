import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';

export type RemovalDecision = 'DELETE' | 'ARCHIVE' | 'BLOCKED';

export interface ReferenceCount {
  readonly table: string;
  readonly column: string;
  readonly label: string;
  readonly count: number;
}

export interface CenterRemovalCheck {
  readonly activeAssets: number;
  readonly activeChildren: number;
  readonly references: ReadonlyArray<ReferenceCount>;
}

export interface UnitRemovalCheck {
  readonly activeChildren: number;
  readonly activeCenters: number;
  readonly references: ReadonlyArray<ReferenceCount>;
}

export interface RemovalVerdict {
  readonly decision: RemovalDecision;
  readonly reason: string | null;
}

const CENTER_CLEANUP = new Set([
  'cost_center_head.cost_center_id',
  'cost_center_placement.cost_center_id',
  'person.cost_center_id',
  'organizational_unit.head_cost_center_id',
]);

const UNIT_CLEANUP = new Set(['person.organizational_unit_id']);

const POLYMORPHIC: ReadonlyArray<readonly [string, string]> = [
  ['physical_inventory', 'scope_id'],
  ['document', 'entity_id'],
  ['generated_document', 'entity_id'],
  ['mail_outbox', 'entity_id'],
];

const TABLE_LABELS: Readonly<Record<string, readonly [string, string]>> = {
  asset: ['activo dado de baja', 'activos dados de baja'],
  asset_movement: ['movimiento de activos', 'movimientos de activos'],
  asset_loan: ['préstamo', 'préstamos'],
  asset_loan_item: ['ítem de préstamo', 'ítems de préstamo'],
  asset_transfer: ['traslado', 'traslados'],
  asset_handover: ['entrega de activos', 'entregas de activos'],
  asset_request: ['solicitud de activos', 'solicitudes de activos'],
  physical_inventory: ['toma de inventario', 'tomas de inventario'],
  physical_inventory_scope: ['toma de inventario', 'tomas de inventario'],
  physical_inventory_item: ['ítem de inventario', 'ítems de inventario'],
  physical_inventory_act: ['acta de inventario', 'actas de inventario'],
  document: ['documento', 'documentos'],
  generated_document: ['documento generado', 'documentos generados'],
  mail_outbox: ['correo', 'correos'],
  cost_center: ['centro de costo archivado', 'centros de costo archivados'],
  cost_center_placement: ['cambio de ubicación', 'cambios de ubicación'],
  organizational_unit: ['dependencia archivada', 'dependencias archivadas'],
};

const counted = (count: number, singular: string, plural: string): string => `${count} ${count === 1 ? singular : plural}`;

const listed = (parts: ReadonlyArray<string>): string =>
  parts.length > 1 ? `${parts.slice(0, -1).join(', ')} y ${parts[parts.length - 1] ?? ''}` : (parts[0] ?? '');

const moveFirst = (count: number, feminine: boolean): string => {
  const ending = `${feminine ? 'a' : 'o'}${count === 1 ? '' : 's'}`;
  return `Muéval${ending} o archível${ending} primero.`;
};

const referenceLabel = (table: string, count: number): string => {
  const [singular, plural] = TABLE_LABELS[table] ?? ['registro relacionado', 'registros relacionados'];
  return count === 1 ? singular : plural;
};

const quoteIdent = (value: string): string => `"${value.replace(/"/g, '""')}"`;

const describe = (references: ReadonlyArray<ReferenceCount>): string =>
  listed(references.map((reference) => `${reference.count} ${reference.label}`));

export const historyReason = (references: ReadonlyArray<ReferenceCount>): string | null =>
  references.length > 0 ? `Tiene ${describe(references)} en su historial.` : null;

export const decideCenterRemoval = (check: CenterRemovalCheck): RemovalVerdict => {
  if (check.activeAssets > 0) {
    return { decision: 'BLOCKED', reason: `Tiene ${counted(check.activeAssets, 'activo asignado', 'activos asignados')}.` };
  }
  if (check.activeChildren > 0) {
    return {
      decision: 'BLOCKED',
      reason: `Tiene ${counted(check.activeChildren, 'centro hijo activo', 'centros hijos activos')}. ${moveFirst(check.activeChildren, false)}`,
    };
  }
  const history = historyReason(check.references);
  if (history) {
    return { decision: 'ARCHIVE', reason: history };
  }
  return { decision: 'DELETE', reason: null };
};

export const assertCenterRemovable = (check: CenterRemovalCheck): RemovalVerdict => {
  if (check.activeAssets > 0) {
    throw new ApiException(ErrorCode.CostCenterHasActiveAssets, undefined, [
      { field: 'activeAssets', message: String(check.activeAssets) },
    ]);
  }
  const verdict = decideCenterRemoval(check);
  if (verdict.decision === 'BLOCKED') {
    throw new ApiException(ErrorCode.HasDependentEntities, verdict.reason ?? undefined, [
      { field: 'activeChildren', message: String(check.activeChildren) },
    ]);
  }
  return verdict;
};

export const decideUnitRemoval = (check: UnitRemovalCheck): RemovalVerdict => {
  if (check.activeChildren > 0 || check.activeCenters > 0) {
    const parts = [
      ...(check.activeChildren > 0 ? [counted(check.activeChildren, 'dependencia activa', 'dependencias activas')] : []),
      ...(check.activeCenters > 0 ? [counted(check.activeCenters, 'centro de costo activo', 'centros de costo activos')] : []),
    ];
    const onlyUnits = check.activeCenters === 0;
    return {
      decision: 'BLOCKED',
      reason: `Tiene ${listed(parts)}. ${moveFirst(check.activeChildren + check.activeCenters, onlyUnits)}`,
    };
  }
  const history = historyReason(check.references);
  if (history) {
    return { decision: 'ARCHIVE', reason: history };
  }
  return { decision: 'DELETE', reason: null };
};

@Injectable()
export class StructureRemovalService {
  async inspectCostCenter(manager: EntityManager, id: string): Promise<CenterRemovalCheck> {
    const [counts] = (await manager.query(
      `SELECT
         (SELECT count(*) FROM asset WHERE current_cost_center_id = $1 AND operational_status <> 'WRITTEN_OFF')::int AS active_assets,
         (SELECT count(*) FROM cost_center WHERE parent_id = $1 AND is_active)::int AS active_children`,
      [id],
    )) as Array<{ active_assets: number; active_children: number }>;
    const references = await this.references(manager, 'cost_center', id, CENTER_CLEANUP);
    return {
      activeAssets: counts?.active_assets ?? 0,
      activeChildren: counts?.active_children ?? 0,
      references,
    };
  }

  async inspectUnit(manager: EntityManager, id: string): Promise<UnitRemovalCheck> {
    const [counts] = (await manager.query(
      `SELECT
         (SELECT count(*) FROM organizational_unit WHERE parent_id = $1 AND is_active)::int AS active_children,
         (SELECT count(*) FROM cost_center WHERE organizational_unit_id = $1 AND is_active)::int AS active_centers`,
      [id],
    )) as Array<{ active_children: number; active_centers: number }>;
    const references = await this.references(manager, 'organizational_unit', id, UNIT_CLEANUP);
    return {
      activeChildren: counts?.active_children ?? 0,
      activeCenters: counts?.active_centers ?? 0,
      references,
    };
  }

  async deleteCostCenter(manager: EntityManager, id: string): Promise<void> {
    await manager.query('DELETE FROM cost_center_head WHERE cost_center_id = $1', [id]);
    await manager.query(`DELETE FROM user_role WHERE scope_type = 'COST_CENTER' AND scope_id = $1`, [id]);
    await manager.query('DELETE FROM cost_center_placement WHERE cost_center_id = $1', [id]);
    await manager.query(`DELETE FROM org_structure_history WHERE entity_type = 'COST_CENTER' AND entity_id = $1`, [id]);
    await manager.query('DELETE FROM cost_center WHERE id = $1', [id]);
  }

  async deleteUnit(manager: EntityManager, id: string): Promise<void> {
    await manager.query(`DELETE FROM user_role WHERE scope_type = 'ORG_UNIT' AND scope_id = $1`, [id]);
    await manager.query(`DELETE FROM org_structure_history WHERE entity_type = 'ORG_UNIT' AND entity_id = $1`, [id]);
    await manager.query('DELETE FROM organizational_unit WHERE id = $1', [id]);
  }

  private async references(
    manager: EntityManager,
    table: string,
    id: string,
    cleanup: ReadonlySet<string>,
  ): Promise<ReferenceCount[]> {
    const foreignKeys = (await manager.query(
      `SELECT cl.relname AS table_name, a.attname AS column_name
       FROM pg_constraint c
       JOIN pg_class cl ON cl.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = cl.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
       WHERE c.contype = 'f' AND c.confrelid = $1::regclass AND n.nspname = current_schema()
       ORDER BY 1, 2`,
      [table],
    )) as Array<{ table_name: string; column_name: string }>;
    const polymorphic = (await manager.query(
      `SELECT t.table_name, t.column_name FROM unnest($1::text[], $2::text[]) AS t(table_name, column_name)
       WHERE to_regclass(t.table_name) IS NOT NULL`,
      [POLYMORPHIC.map(([name]) => name), POLYMORPHIC.map(([, column]) => column)],
    )) as Array<{ table_name: string; column_name: string }>;
    const candidates = [...foreignKeys, ...polymorphic].filter(
      (candidate) => !cleanup.has(`${candidate.table_name}.${candidate.column_name}`),
    );
    const found: ReferenceCount[] = [];
    for (const candidate of candidates) {
      const [row] = (await manager.query(
        `SELECT count(*)::int AS count FROM ${quoteIdent(candidate.table_name)} WHERE ${quoteIdent(candidate.column_name)} = $1`,
        [id],
      )) as Array<{ count: number }>;
      const count = row?.count ?? 0;
      if (count > 0) {
        found.push({
          table: candidate.table_name,
          column: candidate.column_name,
          label: referenceLabel(candidate.table_name, count),
          count,
        });
      }
    }
    return found;
  }
}
