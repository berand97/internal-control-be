import {
  deriveParentCode,
  isDetailCode,
  isRootCode,
  longestPrefix,
  prefixRange,
} from '../../cost-centers/domain/code-prefix.js';

export const STRUCTURE_MODES = ['INSERT_ONLY', 'UPDATE_STRUCTURE'] as const;
export type StructureMode = (typeof STRUCTURE_MODES)[number];

export const isStructureMode = (value: string): value is StructureMode =>
  (STRUCTURE_MODES as ReadonlyArray<string>).includes(value);

export const unitCodeForPrefix = (prefix: string): string => `CC_${prefix}`;

export interface FileCenter {
  readonly rowNumber: number;
  readonly code: string;
  readonly name: string;
  readonly hasMovement: boolean;
  readonly unitCode: string | null;
}

export interface DbCenter {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly unitId: string | null;
  readonly hasMovement: boolean;
  readonly isActive: boolean;
  readonly activeAssets: number;
}

export interface DbUnit {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly codePrefix: string | null;
  readonly isActive: boolean;
}

export type UnitRef = { readonly id: string } | { readonly prefix: string };

export interface PlannedUnit {
  readonly prefix: string;
  readonly rowNumber: number;
  readonly name: string;
  readonly action: 'CREATE' | 'ASSOCIATE' | 'EXISTING';
  readonly unitId: string | null;
  readonly code: string;
}

export interface PlannedCenter {
  readonly rowNumber: number;
  readonly code: string;
  readonly name: string;
  readonly existingId: string | null;
  readonly parentCode: string | null;
  readonly unit: UnitRef | null;
  readonly hasMovement: boolean;
  readonly parentChanges: boolean;
  readonly unitChanges: boolean;
  readonly movementChanges: boolean;
}

export interface PlanIssue {
  readonly rowNumber: number | null;
  readonly code: string;
  readonly rawValue: string | null;
  readonly detail: string;
}

export interface StructurePlanCounts {
  readonly toInsert: number;
  readonly existingInFile: number;
  readonly parentChanges: number;
  readonly unitChanges: number;
  readonly movementChanges: number;
  readonly nameDifferences: number;
  readonly orphans: number;
  readonly groupingCenters: number;
  readonly movementCenters: number;
  readonly unitsToCreate: number;
  readonly unitsToAssociate: number;
  readonly groupingWithAssets: number;
  readonly groupingWithoutChildren: number;
  readonly notInFile: number;
  readonly prefixesWithoutUnit: ReadonlyArray<string>;
}

export interface StructurePlan {
  readonly units: ReadonlyArray<PlannedUnit>;
  readonly centers: ReadonlyArray<PlannedCenter>;
  readonly issues: ReadonlyArray<PlanIssue>;
  readonly counts: StructurePlanCounts;
}

const sameUnit = (unit: UnitRef | null, unitId: string | null): boolean =>
  unit === null ? unitId === null : 'id' in unit && unit.id === unitId;

export const planCostCenterStructure = (
  file: ReadonlyArray<FileCenter>,
  db: ReadonlyArray<DbCenter>,
  units: ReadonlyArray<DbUnit>,
): StructurePlan => {
  const issues: PlanIssue[] = [];
  const dbByCode = new Map(db.map((center) => [center.code, center]));
  const dbById = new Map(db.map((center) => [center.id, center]));
  const rows = file.map((row) => (isRootCode(row.code) ? { ...row, hasMovement: false } : row));
  const fileByCode = new Map(rows.map((row) => [row.code, row]));

  const activeUnits = units.filter((unit) => unit.isActive);
  const plannedUnits: PlannedUnit[] = [];
  for (const row of rows.filter((item) => isRootCode(item.code))) {
    const byPrefix = activeUnits.find((unit) => unit.codePrefix === row.code);
    if (byPrefix) {
      plannedUnits.push({ prefix: row.code, rowNumber: row.rowNumber, name: byPrefix.name, action: 'EXISTING', unitId: byPrefix.id, code: byPrefix.code });
      continue;
    }
    const code = unitCodeForPrefix(row.code);
    const byCode = units.find((unit) => unit.code === code);
    if (byCode && (byCode.codePrefix !== null || !byCode.isActive)) {
      issues.push({
        rowNumber: row.rowNumber,
        code: 'UNIT_PREFIX_CONFLICT',
        rawValue: row.code,
        detail: byCode.isActive
          ? `${byCode.name} ya tiene los códigos que empiezan por ${byCode.codePrefix ?? ''}. No se asigna a los que empiezan por ${row.code}.`
          : `${byCode.name} está archivada. No se asigna a los códigos que empiezan por ${row.code}.`,
      });
      continue;
    }
    if (byCode) {
      plannedUnits.push({ prefix: row.code, rowNumber: row.rowNumber, name: byCode.name, action: 'ASSOCIATE', unitId: byCode.id, code });
      issues.push({
        rowNumber: row.rowNumber,
        code: 'UNIT_ASSOCIATED',
        rawValue: row.code,
        detail: `${byCode.name} queda con los códigos que empiezan por ${row.code}.`,
      });
      continue;
    }
    plannedUnits.push({ prefix: row.code, rowNumber: row.rowNumber, name: row.name, action: 'CREATE', unitId: null, code });
    issues.push({
      rowNumber: row.rowNumber,
      code: 'UNIT_CREATED',
      rawValue: row.code,
      detail: `Se crea la dependencia ${row.name} con los códigos del ${prefixRange(row.code).from} al ${prefixRange(row.code).to}.`,
    });
  }
  const prefixed: Array<{ codePrefix: string; ref: UnitRef }> = [
    ...activeUnits
      .filter((unit) => unit.codePrefix !== null && !plannedUnits.some((planned) => planned.prefix === unit.codePrefix))
      .map((unit) => ({ codePrefix: unit.codePrefix ?? '', ref: { id: unit.id } as UnitRef })),
    ...plannedUnits.map((planned) => ({
      codePrefix: planned.prefix,
      ref: (planned.unitId ? { id: planned.unitId } : { prefix: planned.prefix }) as UnitRef,
    })),
  ];
  const unitByCode = new Map(units.map((unit) => [unit.code, unit]));

  const isGrouping = (code: string): boolean | undefined => {
    const row = fileByCode.get(code);
    if (row) {
      return !row.hasMovement;
    }
    const center = dbByCode.get(code);
    return center ? !center.hasMovement : undefined;
  };

  const centers: PlannedCenter[] = [];
  const prefixesWithoutUnit = new Map<string, number>();
  let orphans = 0;
  let nameDifferences = 0;
  let groupingWithAssets = 0;
  for (const row of rows) {
    const existing = dbByCode.get(row.code) ?? null;
    const derivedParent = deriveParentCode(row.code, isGrouping);
    if (!isRootCode(row.code) && !isDetailCode(row.code)) {
      issues.push({
        rowNumber: row.rowNumber,
        code: 'CODE_OUTSIDE_PLAN',
        rawValue: row.code,
        detail: 'El código no tiene 1 ni 4 dígitos. No se le asigna centro padre ni dependencia.',
      });
    } else if (!isRootCode(row.code) && derivedParent === null) {
      orphans += 1;
      issues.push({
        rowNumber: row.rowNumber,
        code: 'PARENT_NOT_FOUND',
        rawValue: row.code,
        detail: `No existe ninguno de estos centros: ${[`${row.code.slice(0, 3)}0`, `${row.code.slice(0, 2)}00`, `${row.code.slice(0, 1)}000`, row.code.slice(0, 1)]
          .filter((code, index, all) => code !== row.code && all.indexOf(code) === index)
          .join(', ')}. Queda sin centro padre.`,
      });
    }
    if (derivedParent !== null && isGrouping(derivedParent) === false) {
      issues.push({
        rowNumber: row.rowNumber,
        code: 'PARENT_HAS_MOVEMENT',
        rawValue: row.code,
        detail: `Su centro padre ${derivedParent} tiene Movimiento 1. Debería ser agrupador.`,
      });
    }
    const explicit = row.unitCode ? unitByCode.get(row.unitCode) : undefined;
    const byPrefix = isRootCode(row.code) || isDetailCode(row.code) ? longestPrefix(row.code, prefixed) : undefined;
    const unit: UnitRef | null = explicit ? { id: explicit.id } : (byPrefix?.ref ?? null);
    if (!unit && (isRootCode(row.code) || isDetailCode(row.code))) {
      const digit = row.code.slice(0, 1);
      prefixesWithoutUnit.set(digit, (prefixesWithoutUnit.get(digit) ?? 0) + 1);
    }

    let hasMovement = row.hasMovement;
    if (existing && existing.hasMovement && !hasMovement && existing.activeAssets > 0) {
      groupingWithAssets += 1;
      hasMovement = true;
      issues.push({
        rowNumber: row.rowNumber,
        code: 'GROUPING_HAS_ASSETS',
        rawValue: row.code,
        detail: `Tiene ${existing.activeAssets === 1 ? '1 activo' : `${existing.activeAssets} activos`}. Sigue con Movimiento 1 aunque el archivo diga 0.`,
      });
    }
    if (existing && existing.name !== row.name) {
      nameDifferences += 1;
      issues.push({
        rowNumber: row.rowNumber,
        code: 'NAME_DIFFERS',
        rawValue: row.code,
        detail: `El archivo dice ${row.name} y el sistema dice ${existing.name}. El nombre no cambia.`,
      });
    }
    const keepParent = existing !== null && derivedParent === null && !isRootCode(row.code);
    const parentCode = keepParent ? (existing.parentId ? (dbById.get(existing.parentId)?.code ?? null) : null) : derivedParent;
    const currentParentCode = existing?.parentId ? (dbById.get(existing.parentId)?.code ?? null) : null;
    const finalUnit: UnitRef | null = unit ?? (existing?.unitId ? { id: existing.unitId } : null);
    centers.push({
      rowNumber: row.rowNumber,
      code: row.code,
      name: row.name,
      existingId: existing?.id ?? null,
      parentCode,
      unit: finalUnit,
      hasMovement,
      parentChanges: existing !== null && parentCode !== currentParentCode,
      unitChanges: existing !== null && !sameUnit(finalUnit, existing.unitId),
      movementChanges: existing !== null && hasMovement !== existing.hasMovement,
    });
  }

  const inFile = new Set(rows.map((row) => row.code));
  const parents = new Set(
    [
      ...centers.map((center) => center.parentCode),
      ...db
        .filter((center) => !inFile.has(center.code) && center.parentId)
        .map((center) => dbById.get(center.parentId ?? '')?.code ?? null),
    ].filter((code): code is string => code !== null),
  );
  const childless = centers.filter((center) => !center.hasMovement && !parents.has(center.code));
  for (const center of childless) {
    issues.push({
      rowNumber: center.rowNumber,
      code: 'GROUPING_WITHOUT_CHILDREN',
      rawValue: center.code,
      detail: 'Es agrupador pero ningún centro queda debajo por su código.',
    });
  }
  for (const [digit, count] of prefixesWithoutUnit) {
    const range = prefixRange(digit);
    issues.push({
      rowNumber: null,
      code: 'PREFIX_WITHOUT_UNIT',
      rawValue: digit,
      detail: `${count === 1 ? '1 centro' : `${count} centros`} del ${range.from} al ${range.to} quedan sin dependencia. Agregue la fila ${digit} al archivo o asigne esos códigos a una dependencia.`,
    });
  }
  return {
    units: plannedUnits,
    centers,
    issues,
    counts: {
      toInsert: centers.filter((center) => center.existingId === null).length,
      existingInFile: centers.filter((center) => center.existingId !== null).length,
      parentChanges: centers.filter((center) => center.parentChanges).length,
      unitChanges: centers.filter((center) => center.unitChanges).length,
      movementChanges: centers.filter((center) => center.movementChanges).length,
      nameDifferences,
      orphans,
      groupingCenters: centers.filter((center) => !center.hasMovement).length,
      movementCenters: centers.filter((center) => center.hasMovement).length,
      unitsToCreate: plannedUnits.filter((unit) => unit.action === 'CREATE').length,
      unitsToAssociate: plannedUnits.filter((unit) => unit.action === 'ASSOCIATE').length,
      groupingWithAssets,
      groupingWithoutChildren: childless.length,
      notInFile: db.filter((center) => center.isActive && !inFile.has(center.code)).length,
      prefixesWithoutUnit: [...prefixesWithoutUnit.keys()].sort(),
    },
  };
};
