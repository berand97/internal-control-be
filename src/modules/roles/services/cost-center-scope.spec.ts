import { describe, expect, it } from 'vitest';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { EffectivePermission } from '../types/effective-permission.type.js';
import {
  costCenterFilter,
  requireReadableScope,
  resolveCostCenterScope,
} from './cost-center-scope.js';

const GLOBAL = 'asset:read:global';
const SCOPED = 'asset:read:org_unit';

const row = (
  permissionCode: string,
  userScopeType: EffectivePermission['userScopeType'],
  userScopeId: string | null,
): EffectivePermission => ({ permissionCode, userScopeType, userScopeId });

const resolve = (rows: ReadonlyArray<EffectivePermission>) =>
  resolveCostCenterScope(rows, GLOBAL, SCOPED);

const thrownCode = (fn: () => unknown): ErrorCode | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof ApiException ? error.code : undefined;
  }
  return undefined;
};

describe('resolveCostCenterScope', () => {
  it('el permiso global da todo, sin importar el alcance de la asignación', () => {
    expect(resolve([row(GLOBAL, 'GLOBAL', null)])).toEqual({ kind: 'GLOBAL' });
    expect(resolve([row(GLOBAL, 'COST_CENTER', 'cc-1')])).toEqual({ kind: 'GLOBAL' });
    expect(
      resolve([row(SCOPED, 'COST_CENTER', 'cc-1'), row(GLOBAL, 'ORG_UNIT', 'ou-1')]),
    ).toEqual({ kind: 'GLOBAL' });
  });

  it('el permiso acotado da los centros de las asignaciones COST_CENTER, sin repetir y ordenados', () => {
    expect(
      resolve([
        row(SCOPED, 'COST_CENTER', 'cc-2'),
        row(SCOPED, 'COST_CENTER', 'cc-1'),
        row(SCOPED, 'COST_CENTER', 'cc-2'),
        row('loan:read:org_unit', 'COST_CENTER', 'cc-9'),
      ]),
    ).toEqual({ kind: 'COST_CENTERS', costCenterIds: ['cc-1', 'cc-2'] });
  });

  it('ignora asignaciones ORG_UNIT cuando además hay centros', () => {
    expect(
      resolve([row(SCOPED, 'ORG_UNIT', 'ou-1'), row(SCOPED, 'COST_CENTER', 'cc-1')]),
    ).toEqual({ kind: 'COST_CENTERS', costCenterIds: ['cc-1'] });
  });

  it('solo por ORG_UNIT no da centros y lo explica', () => {
    expect(resolve([row(SCOPED, 'ORG_UNIT', 'ou-1')])).toEqual({
      kind: 'EMPTY',
      reason: 'ORG_UNIT_UNRESOLVED',
    });
  });

  it('el permiso acotado asignado con alcance GLOBAL no da centros', () => {
    expect(resolve([row(SCOPED, 'GLOBAL', null)])).toEqual({
      kind: 'EMPTY',
      reason: 'NO_COST_CENTER',
    });
  });

  it('sin ninguno de los dos permisos es DENIED, aunque tenga centros para otro permiso', () => {
    expect(resolve([])).toEqual({ kind: 'DENIED' });
    expect(resolve([row('loan:read:org_unit', 'COST_CENTER', 'cc-1')])).toEqual({
      kind: 'DENIED',
    });
  });

  it('es genérico por código de permiso', () => {
    expect(
      resolveCostCenterScope(
        [row('loan:approve:org_unit', 'COST_CENTER', 'cc-7'), row(SCOPED, 'COST_CENTER', 'cc-1')],
        'loan:approve:global',
        'loan:approve:org_unit',
      ),
    ).toEqual({ kind: 'COST_CENTERS', costCenterIds: ['cc-7'] });
  });
});

describe('requireReadableScope', () => {
  const run = (rows: ReadonlyArray<EffectivePermission>) => () =>
    requireReadableScope(resolve(rows), GLOBAL, SCOPED);

  it('lanza INSUFFICIENT_PERMISSIONS nombrando ambos permisos', () => {
    expect(thrownCode(run([]))).toBe(ErrorCode.InsufficientPermissions);
    expect(run([])).toThrow('Requiere permiso asset:read:global o asset:read:org_unit');
  });

  it('lanza el código que explica la falta de centros', () => {
    expect(thrownCode(run([row(SCOPED, 'GLOBAL', null)]))).toBe(ErrorCode.ScopeNoCostCenter);
    expect(thrownCode(run([row(SCOPED, 'ORG_UNIT', 'ou-1')]))).toBe(
      ErrorCode.ScopeOrgUnitUnresolved,
    );
  });

  it('devuelve el alcance y el filtro de SQL correspondiente', () => {
    expect(costCenterFilter(run([row(GLOBAL, 'GLOBAL', null)])())).toBeNull();
    expect(costCenterFilter(run([row(SCOPED, 'COST_CENTER', 'cc-1')])())).toEqual(['cc-1']);
  });
});
