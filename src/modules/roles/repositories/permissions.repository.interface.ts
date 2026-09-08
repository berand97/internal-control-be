import type { EffectivePermission } from '../types/effective-permission.type.js';

export interface PermissionsRepository {
  findEffectivePermissions(
    userId: string,
  ): Promise<ReadonlyArray<EffectivePermission>>;
}
