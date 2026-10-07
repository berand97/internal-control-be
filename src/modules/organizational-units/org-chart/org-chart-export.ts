import { isDetailCode } from '../../cost-centers/domain/code-prefix.js';
import { resolveCenterParent, resolveCenterUnit } from '../../cost-centers/domain/org-chart-rules.js';
import { ORG_RELATION_TYPE_LABELS, ORG_UNIT_TYPE_LABELS, OrgUnitType } from '../enums/org-unit-type.enum.js';
import type { ExportCenterRow, ExportUnitRow } from './org-chart-workbook.js';
import type { SnapshotCenter, SnapshotUnit } from './org-chart.types.js';

/**
 * Filas de la exportación: unidades en orden de árbol (prefijo, luego nombre) con su profundidad; centros por código
 * con la unidad y el padre DERIVADOS del código para los activos (lo que dejaría la importación), y los guardados
 * para los archivados.
 */
export const orgChartExportRows = (
  units: ReadonlyArray<SnapshotUnit>,
  centers: ReadonlyArray<SnapshotCenter>,
): [ExportUnitRow[], ExportCenterRow[]] => {
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
        headCenter: unit.headCostCenterId ? (centerById.get(unit.headCostCenterId)?.externalCode ?? null) : null,
        isActive: unit.isActive,
        code: unit.code,
      });
      walk(unit.id, depth + 1);
    }
  };
  walk(null, 0);

  const prefixed = units
    .filter((unit) => unit.isActive && unit.codePrefix && unit.unitType !== OrgUnitType.Council)
    .map((unit) => ({ codePrefix: unit.codePrefix ?? '', unit }));
  const liveCodes = new Set(centers.filter((center) => center.isActive).map((center) => center.externalCode));
  const unitLabel = (unit: SnapshotUnit | undefined): string | null =>
    unit ? `${unit.codePrefix ? `${unit.codePrefix} · ` : ''}${unit.name}` : null;
  const centerRows: ExportCenterRow[] = centers.map((center) => {
    let unit = center.unitId ? byId.get(center.unitId) : undefined;
    let parent = center.parentId ? (centerById.get(center.parentId)?.externalCode ?? null) : null;
    if (center.isActive) {
      unit = resolveCenterUnit(center.externalCode, prefixed)?.unit ?? unit;
      if (isDetailCode(center.externalCode)) {
        parent = resolveCenterParent(
          center.externalCode,
          (code) => code !== center.externalCode && liveCodes.has(code),
        ).parentCode;
      }
    }
    return {
      depth: parent ? 1 : 0,
      code: center.externalCode,
      name: center.name,
      hasMovement: center.hasMovement,
      unit: unitLabel(unit),
      parent,
      assets: center.activeAssets,
      isActive: center.isActive,
    };
  });
  return [unitRows, centerRows];
};
