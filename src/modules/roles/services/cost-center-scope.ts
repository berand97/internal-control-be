import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { EffectivePermission } from '../types/effective-permission.type.js';

export type CostCenterScopeReason = 'NO_COST_CENTER' | 'ORG_UNIT_UNRESOLVED';

export type CostCenterScope =
  | { readonly kind: 'GLOBAL' }
  | {
      readonly kind: 'COST_CENTERS';
      readonly costCenterIds: ReadonlyArray<string>;
    }
  | { readonly kind: 'EMPTY'; readonly reason: CostCenterScopeReason }
  | { readonly kind: 'DENIED' };

export type ReadableCostCenterScope =
  | { readonly kind: 'GLOBAL' }
  | {
      readonly kind: 'COST_CENTERS';
      readonly costCenterIds: ReadonlyArray<string>;
    };

export const GLOBAL_COST_CENTER_SCOPE: ReadableCostCenterScope = {
  kind: 'GLOBAL',
};

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

export const costCenterFilter = (
  scope: ReadableCostCenterScope,
): ReadonlyArray<string> | null =>
  scope.kind === 'GLOBAL' ? null : scope.costCenterIds;
