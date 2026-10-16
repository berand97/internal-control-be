import type { EntityManager } from 'typeorm';

export const validAt = (param: string): string =>
  `p.valid_from <= ${param} AND (p.valid_until IS NULL OR p.valid_until > ${param})`;

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
