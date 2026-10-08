import { createHash } from 'node:crypto';
import { isDetailCode, parentCandidates } from './code-prefix.js';
import { resolveCenterParent, resolveCenterUnit } from './org-chart-rules.js';

/**
 * Conciliador de estructura (organigrama ↔ centros de costo), parte pura: compara el estado actual con lo que piden los
 * códigos y devuelve qué cambiar. El código es la fuente de verdad:
 *
 * - Unidad de un centro: la unidad activa con el prefijo más largo con que empieza su código (resolveCenterUnit).
 * - Padre de un centro de 4 dígitos: XYZ0 si existe (resolveCenterParent). Se respeta un padre agrupador (sin
 *   movimiento) que sea un ancestro por código (X000/XY00 de la importación UPDATE_STRUCTURE) cuando la regla no pide
 *   ninguno. Los códigos que no son de 4 dígitos no se re-padrean.
 * - Centro propio de una unidad: se guarda por código; se amarra cuando ese centro existe activo, sigue al centro si lo
 *   recodifican y vuelve a pendiente si lo archivan o lo borran.
 * - Las ubicaciones MANUAL que difieren no se tocan: se listan como excepción.
 *
 * Idempotente: aplicar el plan y volver a planear da un plan vacío (sin relocations/reparents/headLinks/headUnlinks).
 */

export type ReconcileMode = 'AUTO' | 'MANUAL';

export interface ReconcileUnit {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly codePrefix: string | null;
  readonly isActive: boolean;
  readonly headCostCenterId: string | null;
  readonly headCostCenterCode: string | null;
}

export interface ReconcileCenter {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly hasMovement: boolean;
  readonly unitId: string | null;
  readonly parentId: string | null;
  readonly mode: ReconcileMode;
}

export interface ReconcileState {
  readonly units: ReadonlyArray<ReconcileUnit>;
  readonly centers: ReadonlyArray<ReconcileCenter>;
}

/**
 * ALL: toda la estructura. PARTIAL: los centros cuyo código empieza por alguno de los prefijos, los que hoy están en
 * alguna de las unidades, los centros indicados y sus hijos directos. El centro propio de las unidades se revisa
 * siempre (son pocos cientos).
 */
export type ReconcileScope =
  | { readonly kind: 'ALL' }
  | {
      readonly kind: 'PARTIAL';
      readonly prefixes: ReadonlyArray<string>;
      readonly unitIds: ReadonlyArray<string>;
      readonly centerIds: ReadonlyArray<string>;
    };

export const ALL_SCOPE: ReconcileScope = { kind: 'ALL' };

export interface ReconcileUnitRef {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly codePrefix: string | null;
}

export interface ReconcileCenterRef {
  readonly id: string;
  readonly externalCode: string;
  readonly name: string;
}

export interface ReconcileRelocation {
  readonly center: ReconcileCenterRef;
  readonly fromUnit: ReconcileUnitRef | null;
  readonly toUnit: ReconcileUnitRef;
}

export interface ReconcileReparent {
  readonly center: ReconcileCenterRef;
  readonly fromParent: ReconcileCenterRef | null;
  readonly toParent: ReconcileCenterRef | null;
}

export type HeadLinkKind = 'LINKED' | 'RECODED';

export interface ReconcileHeadLink {
  readonly unit: ReconcileUnitRef;
  readonly kind: HeadLinkKind;
  /** Código que queda guardado (el del centro). */
  readonly code: string;
  /** Código guardado antes (RECODED: el viejo; LINKED: el mismo, que estaba pendiente). */
  readonly previousCode: string | null;
  readonly center: ReconcileCenterRef;
}

export type HeadUnlinkReason = 'ARCHIVED' | 'MISSING';

export interface ReconcileHeadUnlink {
  readonly unit: ReconcileUnitRef;
  readonly reason: HeadUnlinkReason;
  /** Código que queda pendiente. */
  readonly code: string | null;
  readonly center: ReconcileCenterRef | null;
}

export type ManualExceptionReason = 'MANUAL' | 'CYCLE';

export interface ReconcileManualException {
  readonly center: ReconcileCenterRef;
  readonly reason: ManualExceptionReason;
  readonly currentUnit: ReconcileUnitRef | null;
  readonly expectedUnit: ReconcileUnitRef | null;
  readonly currentParent: ReconcileCenterRef | null;
  readonly expectedParent: ReconcileCenterRef | null;
}

export interface ReconcileCounts {
  readonly relocations: number;
  readonly reparents: number;
  readonly headLinks: number;
  readonly headUnlinks: number;
  readonly manualExceptions: number;
}

export interface ReconcilePlan {
  readonly relocations: ReadonlyArray<ReconcileRelocation>;
  readonly reparents: ReadonlyArray<ReconcileReparent>;
  readonly headLinks: ReadonlyArray<ReconcileHeadLink>;
  readonly headUnlinks: ReadonlyArray<ReconcileHeadUnlink>;
  readonly manualExceptions: ReadonlyArray<ReconcileManualException>;
  readonly counts: ReconcileCounts;
  /** Huella de los cambios (no de las excepciones): POST /reconcile con expectedHash solo aplica si coincide. */
  readonly hash: string;
}

const MAX_DEPTH = 64;

export const changeCount = (counts: ReconcileCounts): number =>
  counts.relocations + counts.reparents + counts.headLinks + counts.headUnlinks;

const unitRef = (unit: ReconcileUnit): ReconcileUnitRef => ({
  id: unit.id,
  code: unit.code,
  name: unit.name,
  codePrefix: unit.codePrefix,
});

const centerRef = (center: ReconcileCenter): ReconcileCenterRef => ({
  id: center.id,
  externalCode: center.code,
  name: center.name,
});

const inScope = (scope: ReconcileScope, center: ReconcileCenter): boolean => {
  if (scope.kind === 'ALL') {
    return true;
  }
  return (
    scope.prefixes.some((prefix) => prefix.length > 0 && center.code.startsWith(prefix)) ||
    (center.unitId !== null && scope.unitIds.includes(center.unitId)) ||
    scope.centerIds.includes(center.id) ||
    (center.parentId !== null && scope.centerIds.includes(center.parentId))
  );
};

export const planStructureReconcile = (state: ReconcileState, scope: ReconcileScope = ALL_SCOPE): ReconcilePlan => {
  const unitById = new Map(state.units.map((unit) => [unit.id, unit]));
  const prefixedUnits = state.units
    .filter((unit) => unit.isActive && unit.codePrefix)
    .map((unit) => ({ ...unit, codePrefix: unit.codePrefix ?? '' }));
  const centerById = new Map(state.centers.map((center) => [center.id, center]));
  const activeCenters = state.centers.filter((center) => center.isActive).sort((left, right) => left.code.localeCompare(right.code));
  const activeByCode = new Map(activeCenters.map((center) => [center.code, center]));
  const unitOf = (id: string | null): ReconcileUnitRef | null => {
    const unit = id ? unitById.get(id) : undefined;
    return unit ? unitRef(unit) : null;
  };
  const centerOf = (id: string | null): ReconcileCenterRef | null => {
    const center = id ? centerById.get(id) : undefined;
    return center ? centerRef(center) : null;
  };

  const relocations: ReconcileRelocation[] = [];
  const candidates: ReconcileReparent[] = [];
  const manualExceptions: ReconcileManualException[] = [];

  for (const center of activeCenters) {
    if (!inScope(scope, center)) {
      continue;
    }
    const expectedUnit = resolveCenterUnit(center.code, prefixedUnits);
    const unitDiffers = expectedUnit !== undefined && expectedUnit.id !== center.unitId;

    let parentDiffers = false;
    let expectedParentId: string | null = center.parentId;
    if (isDetailCode(center.code)) {
      const rule = resolveCenterParent(center.code, (code) => code !== center.code && activeByCode.has(code));
      const ruleId = rule.parentCode ? (activeByCode.get(rule.parentCode)?.id ?? null) : null;
      if (ruleId !== center.parentId) {
        const current = center.parentId ? centerById.get(center.parentId) : undefined;
        const groupingAncestor =
          ruleId === null &&
          current !== undefined &&
          current.isActive &&
          !current.hasMovement &&
          parentCandidates(center.code).some((candidate) => candidate.code === current.code);
        if (!groupingAncestor) {
          parentDiffers = true;
          expectedParentId = ruleId;
        }
      }
    }
    if (!unitDiffers && !parentDiffers) {
      continue;
    }
    if (center.mode === 'MANUAL') {
      manualExceptions.push({
        center: centerRef(center),
        reason: 'MANUAL',
        currentUnit: unitOf(center.unitId),
        expectedUnit: expectedUnit ? unitRef(expectedUnit) : unitOf(center.unitId),
        currentParent: centerOf(center.parentId),
        expectedParent: centerOf(expectedParentId),
      });
      continue;
    }
    if (unitDiffers && expectedUnit) {
      relocations.push({ center: centerRef(center), fromUnit: unitOf(center.unitId), toUnit: unitRef(expectedUnit) });
    }
    if (parentDiffers) {
      candidates.push({ center: centerRef(center), fromParent: centerOf(center.parentId), toParent: centerOf(expectedParentId) });
    }
  }

  // Un re-padre que cerraría un ciclo (el padre nuevo cuelga del centro por una ubicación MANUAL) no se aplica.
  const finalParent = new Map(state.centers.map((center) => [center.id, center.parentId]));
  for (const reparent of candidates) {
    finalParent.set(reparent.center.id, reparent.toParent?.id ?? null);
  }
  const closesCycle = (centerId: string): boolean => {
    let current = finalParent.get(centerId) ?? null;
    for (let depth = 0; current && depth < MAX_DEPTH; depth += 1) {
      if (current === centerId) {
        return true;
      }
      current = finalParent.get(current) ?? null;
    }
    return false;
  };
  const reparents: ReconcileReparent[] = [];
  for (const reparent of candidates) {
    if (reparent.toParent && closesCycle(reparent.center.id)) {
      finalParent.set(reparent.center.id, reparent.fromParent?.id ?? null);
      const center = centerById.get(reparent.center.id);
      manualExceptions.push({
        center: reparent.center,
        reason: 'CYCLE',
        currentUnit: unitOf(center?.unitId ?? null),
        expectedUnit: unitOf(center?.unitId ?? null),
        currentParent: reparent.fromParent,
        expectedParent: reparent.toParent,
      });
      continue;
    }
    reparents.push(reparent);
  }

  // Centro propio de las unidades activas.
  const headLinks: ReconcileHeadLink[] = [];
  const headUnlinks: ReconcileHeadUnlink[] = [];
  for (const unit of [...state.units].sort((left, right) => left.code.localeCompare(right.code))) {
    if (!unit.isActive) {
      continue;
    }
    if (unit.headCostCenterId) {
      const linked = centerById.get(unit.headCostCenterId);
      if (!linked || !linked.isActive) {
        headUnlinks.push({
          unit: unitRef(unit),
          reason: linked ? 'ARCHIVED' : 'MISSING',
          code: unit.headCostCenterCode ?? linked?.code ?? null,
          center: linked ? centerRef(linked) : null,
        });
      } else if (linked.code !== unit.headCostCenterCode) {
        headLinks.push({
          unit: unitRef(unit),
          kind: 'RECODED',
          code: linked.code,
          previousCode: unit.headCostCenterCode,
          center: centerRef(linked),
        });
      }
      continue;
    }
    if (unit.headCostCenterCode) {
      const found = activeByCode.get(unit.headCostCenterCode);
      if (found) {
        headLinks.push({
          unit: unitRef(unit),
          kind: 'LINKED',
          code: found.code,
          previousCode: unit.headCostCenterCode,
          center: centerRef(found),
        });
      }
    }
  }

  const counts: ReconcileCounts = {
    relocations: relocations.length,
    reparents: reparents.length,
    headLinks: headLinks.length,
    headUnlinks: headUnlinks.length,
    manualExceptions: manualExceptions.length,
  };
  const hash = createHash('sha256')
    .update(
      JSON.stringify({
        relocations: relocations.map((item) => [item.center.id, item.fromUnit?.id ?? null, item.toUnit.id]),
        reparents: reparents.map((item) => [item.center.id, item.fromParent?.id ?? null, item.toParent?.id ?? null]),
        headLinks: headLinks.map((item) => [item.unit.id, item.center.id, item.code]),
        headUnlinks: headUnlinks.map((item) => [item.unit.id, item.code]),
      }),
    )
    .digest('hex');
  return { relocations, reparents, headLinks, headUnlinks, manualExceptions, counts, hash };
};

/**
 * Ámbito barato para los disparadores: los prefijos tocados (el nuevo y el viejo de una unidad; para un centro de 4
 * dígitos, sus 3 primeros, que cubren su padre XYZ0 y sus hermanos XYZn), las unidades y los centros afectados.
 */
export const partialScope = (input: {
  readonly prefixes?: ReadonlyArray<string | null | undefined>;
  readonly centerCodes?: ReadonlyArray<string | null | undefined>;
  readonly unitIds?: ReadonlyArray<string | null | undefined>;
  readonly centerIds?: ReadonlyArray<string | null | undefined>;
}): ReconcileScope => {
  const present = (values: ReadonlyArray<string | null | undefined> | undefined): string[] =>
    [...new Set((values ?? []).filter((value): value is string => typeof value === 'string' && value.length > 0))];
  const fromCodes = present(input.centerCodes).map((code) => (isDetailCode(code) ? code.slice(0, 3) : code));
  return {
    kind: 'PARTIAL',
    prefixes: present([...(input.prefixes ?? []), ...fromCodes]),
    unitIds: present(input.unitIds),
    centerIds: present(input.centerIds),
  };
};

/** Aplica un plan a un estado en memoria (pruebas y convergencia): lo mismo que escribe el servicio. */
export const applyReconcilePlanInMemory = (state: ReconcileState, plan: ReconcilePlan): ReconcileState => {
  const toUnit = new Map(plan.relocations.map((item) => [item.center.id, item.toUnit.id]));
  const toParent = new Map(plan.reparents.map((item) => [item.center.id, item.toParent?.id ?? null]));
  const links = new Map(plan.headLinks.map((item) => [item.unit.id, item]));
  const unlinks = new Map(plan.headUnlinks.map((item) => [item.unit.id, item]));
  return {
    centers: state.centers.map((center) => ({
      ...center,
      unitId: toUnit.has(center.id) ? (toUnit.get(center.id) ?? null) : center.unitId,
      parentId: toParent.has(center.id) ? (toParent.get(center.id) ?? null) : center.parentId,
    })),
    units: state.units.map((unit) => {
      const link = links.get(unit.id);
      if (link) {
        return { ...unit, headCostCenterId: link.center.id, headCostCenterCode: link.code };
      }
      const unlink = unlinks.get(unit.id);
      if (unlink) {
        return { ...unit, headCostCenterId: null, headCostCenterCode: unlink.code };
      }
      return unit;
    }),
  };
};
