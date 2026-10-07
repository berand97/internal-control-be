import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

/**
 * Borrado de verdad de centros de costo y unidades organizacionales (DELETE y la acción ELIMINAR del Excel del
 * organigrama).
 *
 * Centro de costo:
 * - con activos no dados de baja o hijos activos → BLOCKED (409 como siempre);
 * - con cualquier referencia histórica → ARCHIVE (is_active=false) con el motivo;
 * - sin nada → DELETE físico: antes borra sus jefaturas (cost_center_head), los roles con alcance en el centro
 *   (user_role scope COST_CENTER), su historial de ubicación y de nombre/código. Las personas quedan sin centro y las
 *   unidades sin centro propio (FK ON DELETE SET NULL).
 *
 * Referencias históricas: TODAS las FK que apuntan a la tabla, leídas del catálogo de PostgreSQL (así una tabla nueva
 * con FK cuenta sola), menos las que se limpian al borrar; más las referencias polimórficas sin FK (alcance de las
 * tomas de inventario, documentos, correos).
 *
 * Unidad: con hijos activos o centros activos → BLOCKED; con hijos o centros inactivos, historial de ubicación de
 * algún centro u otra referencia → ARCHIVE; si no → DELETE (borra los roles con alcance en la unidad y su historial;
 * las personas quedan sin unidad por SET NULL).
 */

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
  /** Por qué se archiva o se bloquea (en español); null si se borra. */
  readonly reason: string | null;
}

/** FK que no son historia: se limpian (o quedan en NULL) al borrar. */
const CENTER_CLEANUP = new Set([
  'cost_center_head.cost_center_id',
  'cost_center_placement.cost_center_id',
  'person.cost_center_id',
  'organizational_unit.head_cost_center_id',
]);

const UNIT_CLEANUP = new Set(['person.organizational_unit_id']);

/** Referencias polimórficas (sin FK) que también son historia. */
const POLYMORPHIC: ReadonlyArray<readonly [string, string]> = [
  ['physical_inventory', 'scope_id'],
  ['document', 'entity_id'],
  ['generated_document', 'entity_id'],
  ['mail_outbox', 'entity_id'],
];

const TABLE_LABELS: Readonly<Record<string, string>> = {
  asset: 'activos (dados de baja)',
  asset_movement: 'movimientos de activos',
  asset_loan: 'préstamos',
  asset_loan_item: 'ítems de préstamo',
  asset_transfer: 'traslados',
  asset_handover: 'entregas de activos',
  asset_request: 'solicitudes de activos',
  physical_inventory: 'tomas de inventario',
  physical_inventory_scope: 'tomas de inventario',
  physical_inventory_item: 'ítems de inventario',
  physical_inventory_act: 'actas de inventario',
  document: 'documentos',
  generated_document: 'documentos generados',
  mail_outbox: 'correos',
  cost_center: 'centros de costo (inactivos)',
  cost_center_placement: 'historial de ubicación',
  organizational_unit: 'unidades (inactivas)',
};

const quoteIdent = (value: string): string => `"${value.replace(/"/g, '""')}"`;

const describe = (references: ReadonlyArray<ReferenceCount>): string =>
  references.map((reference) => `${reference.count} ${reference.label}`).join(', ');

/** Motivo para archivar en vez de borrar; null si no hay ninguna referencia histórica. */
export const historyReason = (references: ReadonlyArray<ReferenceCount>): string | null =>
  references.length > 0 ? `Se archiva porque tiene historia: ${describe(references)}` : null;

export const decideCenterRemoval = (check: CenterRemovalCheck): RemovalVerdict => {
  if (check.activeAssets > 0) {
    return { decision: 'BLOCKED', reason: `Tiene ${check.activeAssets} activos asignados` };
  }
  if (check.activeChildren > 0) {
    return { decision: 'BLOCKED', reason: `Tiene ${check.activeChildren} centros hijos activos` };
  }
  const history = historyReason(check.references);
  if (history) {
    return { decision: 'ARCHIVE', reason: history };
  }
  return { decision: 'DELETE', reason: null };
};

export const decideUnitRemoval = (check: UnitRemovalCheck): RemovalVerdict => {
  if (check.activeChildren > 0 || check.activeCenters > 0) {
    const parts = [
      ...(check.activeChildren > 0 ? [`${check.activeChildren} unidades hijas activas`] : []),
      ...(check.activeCenters > 0 ? [`${check.activeCenters} centros de costo activos`] : []),
    ];
    return { decision: 'BLOCKED', reason: `Tiene ${parts.join(' y ')}` };
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

  /** Borra el centro y lo que no es historia. Llamar solo con decideCenterRemoval = DELETE, en una transacción. */
  async deleteCostCenter(manager: EntityManager, id: string): Promise<void> {
    await manager.query('DELETE FROM cost_center_head WHERE cost_center_id = $1', [id]);
    await manager.query(`DELETE FROM user_role WHERE scope_type = 'COST_CENTER' AND scope_id = $1`, [id]);
    await manager.query('DELETE FROM cost_center_placement WHERE cost_center_id = $1', [id]);
    await manager.query(`DELETE FROM org_structure_history WHERE entity_type = 'COST_CENTER' AND entity_id = $1`, [id]);
    await manager.query('DELETE FROM cost_center WHERE id = $1', [id]);
  }

  /** Borra la unidad. Llamar solo con decideUnitRemoval = DELETE, en una transacción. */
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
          label: TABLE_LABELS[candidate.table_name] ?? candidate.table_name,
          count,
        });
      }
    }
    return found;
  }
}
