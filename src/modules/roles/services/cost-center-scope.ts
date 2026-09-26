import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { EffectivePermission } from '../types/effective-permission.type.js';

/**
 * Por qué un usuario con el permiso acotado no alcanza ningún centro de costo.
 * - NO_COST_CENTER: no tiene ninguna asignación vigente con scope_type
 *   COST_CENTER para un rol que otorgue el permiso (incluye asignaciones GLOBAL
 *   de un rol que solo trae el permiso acotado) ni su persona dirige hoy
 *   ningún centro (cost_center_head).
 * - ORG_UNIT_UNRESOLVED: tiene el permiso por una asignación ORG_UNIT, pero aún
 *   no está definido qué centros de costo cubre una unidad organizacional.
 */
export type CostCenterScopeReason = 'NO_COST_CENTER' | 'ORG_UNIT_UNRESOLVED';

export type CostCenterScope =
  | { readonly kind: 'GLOBAL' }
  | {
      readonly kind: 'COST_CENTERS';
      readonly costCenterIds: ReadonlyArray<string>;
    }
  | { readonly kind: 'EMPTY'; readonly reason: CostCenterScopeReason }
  | { readonly kind: 'DENIED' };

/** Alcance ya validado: todo o una lista no vacía de centros de costo. */
export type ReadableCostCenterScope =
  | { readonly kind: 'GLOBAL' }
  | {
      readonly kind: 'COST_CENTERS';
      readonly costCenterIds: ReadonlyArray<string>;
    };

export const GLOBAL_COST_CENTER_SCOPE: ReadableCostCenterScope = {
  kind: 'GLOBAL',
};

/**
 * Resuelve sobre qué centros de costo puede actuar un usuario para un par de
 * permisos (uno :global, otro acotado). Las filas vienen de
 * v_user_effective_permissions, que ya descarta asignaciones revocadas, aún no
 * vigentes o vencidas, y expande la herencia de roles con el mismo alcance.
 *
 * El permiso :global gana con cualquier alcance de asignación, igual que en
 * PermissionsService.userHasPermission.
 *
 * `headedCostCenterIds` son los centros que la persona del usuario dirige hoy
 * (cost_center_head vigente). El ROL sigue dando el permiso: sin el permiso
 * acotado la jefatura no da acceso; con él, los centros alcanzados son los de
 * las asignaciones COST_CENTER ∪ los que dirige.
 */
export const resolveCostCenterScope = (
  permissions: ReadonlyArray<EffectivePermission>,
  globalCode: string,
  scopedCode: string,
  headedCostCenterIds: ReadonlyArray<string> = [],
): CostCenterScope => {
  if (permissions.some((permission) => permission.permissionCode === globalCode)) {
    return { kind: 'GLOBAL' };
  }
  const scoped = permissions.filter(
    (permission) => permission.permissionCode === scopedCode,
  );
  if (scoped.length === 0) {
    return { kind: 'DENIED' };
  }
  const costCenterIds = [
    ...new Set([
      ...scoped.flatMap((permission) =>
        permission.userScopeType === 'COST_CENTER' && permission.userScopeId
          ? [permission.userScopeId]
          : [],
      ),
      ...headedCostCenterIds,
    ]),
  ].sort();
  if (costCenterIds.length > 0) {
    return { kind: 'COST_CENTERS', costCenterIds };
  }
  const viaOrgUnit = scoped.some(
    (permission) => permission.userScopeType === 'ORG_UNIT',
  );
  return {
    kind: 'EMPTY',
    reason: viaOrgUnit ? 'ORG_UNIT_UNRESOLVED' : 'NO_COST_CENTER',
  };
};

const REASON_ERRORS: Record<CostCenterScopeReason, ErrorCode> = {
  NO_COST_CENTER: ErrorCode.ScopeNoCostCenter,
  ORG_UNIT_UNRESOLVED: ErrorCode.ScopeOrgUnitUnresolved,
};

/**
 * Convierte el alcance en uno utilizable o lanza el error que explica por qué
 * no: 403 INSUFFICIENT_PERMISSIONS si no tiene ninguno de los dos permisos,
 * 403 SCOPE_NO_COST_CENTER / SCOPE_ORG_UNIT_UNRESOLVED si tiene el acotado
 * pero no alcanza ningún centro.
 */
export const requireReadableScope = (
  scope: CostCenterScope,
  globalCode: string,
  scopedCode: string,
): ReadableCostCenterScope => {
  if (scope.kind === 'DENIED') {
    throw new ApiException(
      ErrorCode.InsufficientPermissions,
      `Requiere permiso ${globalCode} o ${scopedCode}`,
    );
  }
  if (scope.kind === 'EMPTY') {
    throw new ApiException(REASON_ERRORS[scope.reason]);
  }
  return scope;
};

/** null = sin filtro; arreglo = solo esos centros. */
export const costCenterFilter = (
  scope: ReadableCostCenterScope,
): ReadonlyArray<string> | null =>
  scope.kind === 'GLOBAL' ? null : scope.costCenterIds;
