import type { TokenScopeType } from '../../../common/types/authenticated-user.type.js';

export interface PermissionScope {
  readonly type: TokenScopeType;
  readonly id: string;
}

export interface EffectivePermission {
  readonly permissionCode: string;
  readonly userScopeType: TokenScopeType;
  readonly userScopeId: string | null;
}
