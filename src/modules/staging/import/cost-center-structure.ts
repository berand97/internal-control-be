import {
  deriveParentCode,
  isDetailCode,
  isRootCode,
  longestPrefix,
  prefixRange,
} from '../../cost-centers/domain/code-prefix.js';

/**
 * Plan de la importación de centros de costo en modo «actualizar estructura» (structureMode = UPDATE_STRUCTURE).
 * Función pura: la vista previa y la confirmación calculan exactamente lo mismo con los mismos datos.
 *
 * Reglas (ver también TARGET_RULES.COST_CENTERS):
 * - Padre derivado del código (el archivo no trae columna de padre): primer código existente, en el archivo o en la
 *   base, entre XYZ0 (si no es el propio código y es agrupador), XY00, X000 y X. No se usan los nombres.
 * - Un código de un dígito es agrupador y raíz, y crea (o asocia) la unidad VICERECTORATE con code_prefix = ese dígito
 *   y el nombre de la fila. Los demás toman la unidad por prefijo (el más largo) o la de la columna unitCode.
 * - Un prefijo sin fila de un dígito ni unidad con ese prefijo (el 3 de la hoja 2025): no se inventa unidad; esos
 *   centros quedan sin unidad y el plan lo avisa.
 * - Existentes: cambian padre, unidad y movimiento; nunca el código ni el nombre (un nombre distinto se cuenta y se
 *   lista). Un padre o una unidad que no se pueden derivar no borran los que el centro ya tiene (salvo la raíz, que
 *   queda sin padre). Uno con activos no pasa a agrupador (se lista). Los que no vienen en el archivo no se tocan.
 */

export const STRUCTURE_MODES = ['INSERT_ONLY', 'UPDATE_STRUCTURE'] as const;
export type StructureMode = (typeof STRUCTURE_MODES)[number];

export const isStructureMode = (value: string): value is StructureMode =>
  (STRUCTURE_MODES as ReadonlyArray<string>).includes(value);

/** Código de la unidad que se crea para un prefijo de un dígito (SCREAMING_SNAKE_CASE como exige el CRUD). */
export const unitCodeForPrefix = (prefix: string): string => `CC_${prefix}`;

export interface FileCenter {
  readonly rowNumber: number;
  readonly code: string;
  readonly name: string;
  readonly hasMovement: boolean;
  /** Código de unidad de la columna unitCode (ya validado contra la base). */
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

/** Unidad del plan: una existente (id) o la que se crea para un prefijo. */
export type UnitRef = { readonly id: string } | { readonly prefix: string };

export interface PlannedUnit {
  readonly prefix: string;
  readonly rowNumber: number;
  readonly name: string;
  /** CREATE: unidad nueva; ASSOCIATE: unidad existente (por código CC_<n>) que recibe el prefijo; EXISTING: ya lo tenía. */
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
  // Un dígito = agrupador, sin importar lo que diga la fila.
  const rows = file.map((row) => (isRootCode(row.code) ? { ...row, hasMovement: false } : row));
  const fileByCode = new Map(rows.map((row) => [row.code, row]));

  // Unidades de los códigos de un dígito.
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
        detail: `Ya existe la unidad «${byCode.name}» ${byCode.isActive ? `para los códigos que empiezan por ${byCode.codePrefix ?? ''}` : 'y está desactivada'}: no se crea ni se asigna una unidad para los códigos que empiezan por ${row.code}`,
      });
      continue;
    }
    if (byCode) {
      plannedUnits.push({ prefix: row.code, rowNumber: row.rowNumber, name: byCode.name, action: 'ASSOCIATE', unitId: byCode.id, code });
      issues.push({
        rowNumber: row.rowNumber,
        code: 'UNIT_ASSOCIATED',
        rawValue: row.code,
        detail: `La unidad «${byCode.name}», que ya existe, queda para los códigos que empiezan por ${row.code}`,
      });
      continue;
    }
    plannedUnits.push({ prefix: row.code, rowNumber: row.rowNumber, name: row.name, action: 'CREATE', unitId: null, code });
    issues.push({
      rowNumber: row.rowNumber,
      code: 'UNIT_CREATED',
      rawValue: row.code,
      detail: `Se crea la unidad «${row.name}» para los códigos que empiezan por ${row.code} (del ${prefixRange(row.code).from} al ${prefixRange(row.code).to})`,
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
        detail: 'El código no es de 1 ni de 4 dígitos: no se deriva su padre ni su unidad por prefijo',
      });
    } else if (!isRootCode(row.code) && derivedParent === null) {
      orphans += 1;
      issues.push({
        rowNumber: row.rowNumber,
        code: 'PARENT_NOT_FOUND',
        rawValue: row.code,
        detail: `No existe ninguno de ${[`${row.code.slice(0, 3)}0`, `${row.code.slice(0, 2)}00`, `${row.code.slice(0, 1)}000`, row.code.slice(0, 1)]
          .filter((code, index, all) => code !== row.code && all.indexOf(code) === index)
          .join(', ')}: queda sin padre`,
      });
    }
    if (derivedParent !== null && isGrouping(derivedParent) === false) {
      issues.push({
        rowNumber: row.rowNumber,
        code: 'PARENT_HAS_MOVEMENT',
        rawValue: row.code,
        detail: `El centro padre que le corresponde por su código, ${derivedParent}, recibe movimientos (Movimiento 1): no es agrupador`,
      });
    }
    // Unidad: columna unitCode, o prefijo más largo; null = no se sabe (no borra la que tenga).
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
        detail: `El archivo lo marca agrupador (Movimiento 0) pero tiene ${existing.activeAssets} activos: sigue con movimiento`,
      });
    }
    if (existing && existing.name !== row.name) {
      nameDifferences += 1;
      issues.push({
        rowNumber: row.rowNumber,
        code: 'NAME_DIFFERS',
        rawValue: row.code,
        detail: `En el sistema: «${existing.name}»; en el archivo: «${row.name}». El nombre no se cambia`,
      });
    }
    // Sin padre derivable, un existente conserva el suyo (la raíz sí queda sin padre).
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

  // Agrupadores que no quedan con hijos (9205 en la hoja 2025: sus hijos por nombre van a 9200 por código).
  const inFile = new Set(rows.map((row) => row.code));
  const parents = new Set(
    [
      ...centers.map((center) => center.parentCode),
      // Los centros que no vienen en el archivo conservan su padre.
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
      detail: 'Es agrupador (Movimiento 0) pero ningún código queda bajo él por la regla del código: revise si agrupa centros solo por nombre',
    });
  }
  for (const [digit, count] of prefixesWithoutUnit) {
    const range = prefixRange(digit);
    issues.push({
      rowNumber: null,
      code: 'PREFIX_WITHOUT_UNIT',
      rawValue: digit,
      detail: `${count} centros del ${range.from} al ${range.to} quedan sin unidad: el archivo no trae la fila «${digit}» ni hay una unidad para los códigos que empiezan por ${digit}. No se crea ninguna unidad por su cuenta`,
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
