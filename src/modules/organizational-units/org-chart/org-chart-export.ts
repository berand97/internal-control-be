import { ORG_RELATION_TYPE_LABELS, ORG_UNIT_TYPE_LABELS } from '../enums/org-unit-type.enum.js';
import type { ExportUnitRow } from './org-chart-workbook.js';
import type { SnapshotCenter, SnapshotUnit } from './org-chart.types.js';

/**
 * Filas de la exportación: unidades en orden de árbol (prefijo, luego nombre) con su profundidad. Los centros solo se
 * usan para escribir el código del Centro propio.
 */
export const orgChartExportRows = (
  units: ReadonlyArray<SnapshotUnit>,
  centers: ReadonlyArray<SnapshotCenter>,
): ExportUnitRow[] => {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const centerById = new Map(centers.map((center) => [center.id, center]));
  const childrenOf = new Map<string | null, SnapshotUnit[]>();
  for (const unit of units) {
    const key = unit.parentId && byId.has(unit.parentId) ? unit.parentId : null;
    childrenOf.set(key, [...(childrenOf.get(key) ?? []), unit]);
  }
  const order = (left: SnapshotUnit, right: SnapshotUnit): number => {
    if (left.codePrefix && right.codePrefix) {
      return left.codePrefix.localeCompare(right.codePrefix);
    }
    if (left.codePrefix || right.codePrefix) {
      return left.codePrefix ? -1 : 1;
    }
    return left.name.localeCompare(right.name, 'es');
  };
  const unitRows: ExportUnitRow[] = [];
  const visited = new Set<string>();
  const walk = (parentId: string | null, depth: number): void => {
    for (const unit of [...(childrenOf.get(parentId) ?? [])].sort(order)) {
      if (visited.has(unit.id)) {
        continue;
      }
      visited.add(unit.id);
      const parent = unit.parentId ? byId.get(unit.parentId) : undefined;
      unitRows.push({
        depth,
        prefix: unit.codePrefix,
        name: unit.name,
        typeLabel: ORG_UNIT_TYPE_LABELS[unit.unitType] ?? unit.unitType,
        parent: parent ? (parent.codePrefix ?? parent.code) : null,
        relationLabel: ORG_RELATION_TYPE_LABELS[unit.relationType] ?? unit.relationType,
        // Amarrado: el código vigente del centro; pendiente: el código escrito.
        headCenter:
          (unit.headCostCenterId ? centerById.get(unit.headCostCenterId)?.externalCode : undefined) ??
          unit.headCostCenterCode ??
          null,
        color: unit.color ?? null,
        isActive: unit.isActive,
        code: unit.code,
      });
      walk(unit.id, depth + 1);
    }
  };
  walk(null, 0);

  return unitRows;
};
