import type { EffectivePermission } from '../types/effective-permission.type.js';

export interface PermissionsRepository {
  findEffectivePermissions(
    userId: string,
  ): Promise<ReadonlyArray<EffectivePermission>>;

  /**
   * Centros de costo que dirige hoy la persona del usuario (cost_center_head vigente: valid_from <= ahora y
   * valid_until nulo o posterior). Ordenados, sin repetidos.
   */
  findHeadedCostCenterIds(userId: string): Promise<ReadonlyArray<string>>;
}
