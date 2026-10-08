import { describe, expect, it } from 'vitest';
import {
  applyReconcilePlanInMemory,
  changeCount,
  partialScope,
  planStructureReconcile,
  type ReconcileCenter,
  type ReconcileState,
  type ReconcileUnit,
} from './structure-reconcile.js';

const unit = (id: string, prefix: string | null, extra: Partial<ReconcileUnit> = {}): ReconcileUnit => ({
  id,
  code: id.toUpperCase(),
  name: `Unidad ${prefix ?? id}`,
  codePrefix: prefix,
  isActive: true,
  headCostCenterId: null,
  headCostCenterCode: null,
  ...extra,
});

const center = (code: string, unitId: string | null, extra: Partial<ReconcileCenter> = {}): ReconcileCenter => ({
  id: `c${code}`,
  code,
  name: `Centro ${code}`,
  isActive: true,
  hasMovement: true,
  unitId,
  parentId: null,
  mode: 'AUTO',
  ...extra,
});

/** Aplica planes hasta que no quede nada (máximo 5 vueltas) y devuelve el estado final. */
const converge = (state: ReconcileState): ReconcileState => {
  let current = state;
  for (let round = 0; round < 5; round += 1) {
    const plan = planStructureReconcile(current);
    if (changeCount(plan.counts) === 0) {
      return current;
    }
    current = applyReconcilePlanInMemory(current, plan);
  }
  throw new Error('no converge');
};

const normalize = (state: ReconcileState) => ({
  units: [...state.units].sort((a, b) => a.id.localeCompare(b.id)),
  centers: [...state.centers].sort((a, b) => a.id.localeCompare(b.id)),
});

describe('planStructureReconcile', () => {
  it('unidad 43 creada después: mueve 4310–4360 desde la 4 y les pone su padre XYZ0', () => {
    const state: ReconcileState = {
      units: [unit('u4', '4'), unit('u43', '43')],
      centers: [
        center('4010', 'u4'),
        center('4310', 'u4'),
        center('4320', 'u4'),
        center('4350', 'u4'),
        center('4351', 'u4'),
        center('4360', 'u4'),
      ],
    };
    const plan = planStructureReconcile(state);
    expect(plan.relocations.map((item) => [item.center.externalCode, item.fromUnit?.id, item.toUnit.id])).toEqual([
      ['4310', 'u4', 'u43'],
      ['4320', 'u4', 'u43'],
      ['4350', 'u4', 'u43'],
      ['4351', 'u4', 'u43'],
      ['4360', 'u4', 'u43'],
    ]);
    expect(plan.reparents.map((item) => [item.center.externalCode, item.toParent?.externalCode])).toEqual([['4351', '4350']]);
    expect(plan.counts).toMatchObject({ relocations: 5, reparents: 1, headLinks: 0, headUnlinks: 0 });
  });

  it('es idempotente: aplicar y volver a planear no cambia nada (y el hash del plan vacío es estable)', () => {
    const state: ReconcileState = {
      units: [unit('u4', '4'), unit('u43', '43', { headCostCenterCode: '4310' })],
      centers: [center('4310', 'u4'), center('4311', null), center('4010', 'u4')],
    };
    const first = planStructureReconcile(state);
    expect(changeCount(first.counts)).toBeGreaterThan(0);
    const after = applyReconcilePlanInMemory(state, first);
    const second = planStructureReconcile(after);
    expect(changeCount(second.counts)).toBe(0);
    expect(planStructureReconcile(after).hash).toBe(second.hash);
    expect(second.hash).not.toBe(first.hash);
  });

  it('organigrama→centros y centros→organigrama convergen al mismo estado', () => {
    // A: primero el organigrama (43 con centro propio pendiente 4310), después los centros (creados en la 4).
    const orgFirst: ReconcileState = {
      units: [unit('u4', '4'), unit('u43', '43', { headCostCenterCode: '4310' })],
      centers: [center('4010', 'u4'), center('4310', 'u4'), center('4311', 'u4')],
    };
    // B: primero los centros (todos en la 4), después la unidad 43 con su centro propio ya amarrado.
    const centersFirst: ReconcileState = {
      units: [unit('u4', '4'), unit('u43', '43', { headCostCenterId: 'c4310', headCostCenterCode: '4310' })],
      centers: [center('4010', 'u4'), center('4310', 'u4'), center('4311', 'u4', { parentId: 'c4310' })],
    };
    expect(normalize(converge(orgFirst))).toEqual(normalize(converge(centersFirst)));
    const final = converge(orgFirst);
    expect(final.centers.find((item) => item.code === '4311')).toMatchObject({ unitId: 'u43', parentId: 'c4310' });
    expect(final.units.find((item) => item.id === 'u43')).toMatchObject({ headCostCenterId: 'c4310', headCostCenterCode: '4310' });
  });

  it('respeta las ubicaciones MANUAL: no las mueve y las lista como excepción', () => {
    const state: ReconcileState = {
      units: [unit('u4', '4'), unit('u43', '43')],
      centers: [center('4310', 'u4', { mode: 'MANUAL' }), center('4320', 'u4')],
    };
    const plan = planStructureReconcile(state);
    expect(plan.relocations.map((item) => item.center.externalCode)).toEqual(['4320']);
    expect(plan.manualExceptions).toEqual([
      expect.objectContaining({
        reason: 'MANUAL',
        center: expect.objectContaining({ externalCode: '4310' }),
        currentUnit: expect.objectContaining({ id: 'u4' }),
        expectedUnit: expect.objectContaining({ id: 'u43' }),
      }),
    ]);
  });

  it('centro propio recodificado: la unidad sigue al centro con su código nuevo', () => {
    const state: ReconcileState = {
      units: [unit('u15', '15', { headCostCenterId: 'c1510', headCostCenterCode: '1510' })],
      centers: [{ ...center('1520', 'u15'), id: 'c1510' }],
    };
    const plan = planStructureReconcile(state);
    expect(plan.headLinks).toEqual([
      expect.objectContaining({ kind: 'RECODED', code: '1520', previousCode: '1510', center: expect.objectContaining({ id: 'c1510' }) }),
    ]);
    const after = applyReconcilePlanInMemory(state, plan);
    expect(after.units[0]).toMatchObject({ headCostCenterId: 'c1510', headCostCenterCode: '1520' });
  });

  it('centro propio archivado: la unidad vuelve a pendiente con el mismo código y se amarra al reactivarlo', () => {
    const archived: ReconcileState = {
      units: [unit('u15', '15', { headCostCenterId: 'c1510', headCostCenterCode: '1510' })],
      centers: [center('1510', 'u15', { isActive: false })],
    };
    const plan = planStructureReconcile(archived);
    expect(plan.headUnlinks).toEqual([expect.objectContaining({ reason: 'ARCHIVED', code: '1510' })]);
    const pending = applyReconcilePlanInMemory(archived, plan);
    expect(pending.units[0]).toMatchObject({ headCostCenterId: null, headCostCenterCode: '1510' });
    expect(changeCount(planStructureReconcile(pending).counts)).toBe(0);
    const reactivated = { ...pending, centers: pending.centers.map((item) => ({ ...item, isActive: true })) };
    expect(planStructureReconcile(reactivated).headLinks).toEqual([expect.objectContaining({ kind: 'LINKED', code: '1510' })]);
  });

  it('centro propio borrado (el FK dejó el id en null): queda pendiente sin cambios que aplicar', () => {
    const state: ReconcileState = {
      units: [unit('u15', '15', { headCostCenterId: null, headCostCenterCode: '1510' })],
      centers: [],
    };
    expect(changeCount(planStructureReconcile(state).counts)).toBe(0);
  });

  it('Control Interno (432) movido de Contabilidad (43) a Rectoría (1): el centro 4320 sigue en 432', () => {
    const state: ReconcileState = {
      units: [
        unit('u1', '1'),
        unit('u4', '4'),
        unit('u43', '43'),
        unit('u432', '432', { headCostCenterId: 'c4320', headCostCenterCode: '4320' }),
      ],
      centers: [center('4320', 'u432'), center('4321', 'u432', { parentId: 'c4320' }), center('4310', 'u43')],
    };
    const plan = planStructureReconcile(state);
    expect(changeCount(plan.counts)).toBe(0);
    expect(plan.manualExceptions).toEqual([]);
  });

  it('respeta un padre agrupador ancestro por código (X000/XY00) cuando la regla no pide XYZ0', () => {
    const state: ReconcileState = {
      units: [unit('u4', '4')],
      centers: [center('4100', 'u4', { hasMovement: false }), center('4110', 'u4', { parentId: 'c4100' })],
    };
    expect(changeCount(planStructureReconcile(state).counts)).toBe(0);
  });

  it('no cierra ciclos: un re-padre contra una ubicación MANUAL que cuelga del centro queda como excepción', () => {
    const state: ReconcileState = {
      units: [unit('u43', '43')],
      centers: [center('4350', 'u43', { mode: 'MANUAL', parentId: 'c4351' }), center('4351', 'u43')],
    };
    const plan = planStructureReconcile(state);
    expect(plan.reparents).toEqual([]);
    expect(plan.manualExceptions.map((item) => [item.center.externalCode, item.reason])).toEqual(
      expect.arrayContaining([['4351', 'CYCLE']]),
    );
  });

  it('ámbito parcial: solo los centros del prefijo, de las unidades o los indicados', () => {
    const state: ReconcileState = {
      units: [unit('u4', '4'), unit('u43', '43'), unit('u2', '2'), unit('u25', '25')],
      centers: [center('4310', 'u4'), center('2510', 'u2')],
    };
    const plan = planStructureReconcile(state, partialScope({ centerCodes: ['4310'] }));
    expect(plan.relocations.map((item) => item.center.externalCode)).toEqual(['4310']);
    expect(planStructureReconcile(state, partialScope({ prefixes: ['25'] })).relocations.map((item) => item.center.externalCode)).toEqual(['2510']);
    expect(planStructureReconcile(state, partialScope({ unitIds: ['u2'] })).relocations.map((item) => item.center.externalCode)).toEqual(['2510']);
  });

  it('no mueve un centro cuyo código no cae en ninguna unidad', () => {
    const state: ReconcileState = { units: [unit('u4', '4')], centers: [center('9228', null)] };
    expect(changeCount(planStructureReconcile(state).counts)).toBe(0);
  });
});
