import { SetMetadata } from '@nestjs/common';
import type { AuthenticatedRequest } from '../types/authenticated-request.type.js';
import type { TokenScopeType } from '../types/authenticated-user.type.js';

export const REQUIRE_PERMISSION_KEY = 'requirePermission';

export interface PermissionRequirement {
  readonly code: string;
  readonly scopeType?: TokenScopeType;
  readonly scopeFrom?: (req: AuthenticatedRequest) => string | undefined;
}

export const RequirePermission = (
  requirement: string | PermissionRequirement,
): MethodDecorator => {
  const value: PermissionRequirement =
    typeof requirement === 'string' ? { code: requirement } : requirement;
  return SetMetadata(REQUIRE_PERMISSION_KEY, value);
};
