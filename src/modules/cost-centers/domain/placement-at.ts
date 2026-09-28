import type { EntityManager } from 'typeorm';

/** Condición «vigente en el instante del parámetro» sobre el alias p (cost_center_placement). */
export const validAt = (param: string): string =>
  `p.valid_from <= ${param} AND (p.valid_until IS NULL OR p.valid_until > ${param})`;

/**
 * Unidad de un centro vigente en un instante (para el acta: la de la fecha de emisión, no la actual). null si el centro
 * no tenía ubicación en esa fecha o no tenía unidad.
 */
export const unitAt = async (
  manager: EntityManager,
  costCenterId: string,
  at: Date,
): Promise<{ readonly code: string; readonly name: string } | null> => {
  const [row] = (await manager.query(
    `SELECT u.code, u.name FROM cost_center_placement p JOIN organizational_unit u ON u.id = p.organizational_unit_id
     WHERE p.cost_center_id = $1 AND ${validAt('$2')}`,
    [costCenterId, at],
  )) as Array<{ code: string; name: string }>;
  return row ?? null;
};
