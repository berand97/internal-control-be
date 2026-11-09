import type { EffectivePermission } from '../types/effective-permission.type.js';

export interface PermissionsRepository {
  findEffectivePermissions(
    userId: string,
  ): Promise<ReadonlyArray<EffectivePermission>>;

  findHeadedCostCenterIds(userId: string): Promise<ReadonlyArray<string>>;

  findCostCenterIdsUnderOrgUnits(
    orgUnitIds: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<string>>;
}
