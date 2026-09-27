import { InventoryScopeType } from '../enums/inventory-scope.js';

export interface ScopeSql {
  readonly sql: string;
  readonly params: ReadonlyArray<string>;
}

/**
 * Condición SQL sobre `asset` (alias `alias`) que selecciona los activos de un alcance de toma. Los parámetros
 * empiezan en `$paramIndex`. Un activo pertenece a un centro de costo por asset.current_cost_center_id; una unidad
 * organizacional incluye los centros de toda su subárbol.
 */
export const scopeSql = (
  alias: string,
  scopeType: InventoryScopeType,
  scopeId: string | null,
  paramIndex: number,
): ScopeSql => {
  if (scopeType === InventoryScopeType.Global) {
    return { sql: 'TRUE', params: [] };
  }
  if (!scopeId) {
    return { sql: 'FALSE', params: [] };
  }
  const placeholder = `$${paramIndex}`;
  if (scopeType === InventoryScopeType.CostCenter) {
    return {
      sql: `${alias}.current_cost_center_id = ${placeholder}`,
      params: [scopeId],
    };
  }
  if (scopeType === InventoryScopeType.Location) {
    return {
      sql: `${alias}.current_location_id = ${placeholder}`,
      params: [scopeId],
    };
  }
  return {
    sql: `${alias}.current_cost_center_id IN (
      SELECT cc.id FROM cost_center cc
      WHERE cc.organizational_unit_id IN (
        WITH RECURSIVE tree AS (
          SELECT id FROM organizational_unit WHERE id = ${placeholder}
          UNION ALL
          SELECT u.id FROM organizational_unit u JOIN tree t ON u.parent_id = t.id
        )
        SELECT id FROM tree
      )
    )`,
    params: [scopeId],
  };
};
