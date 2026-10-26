import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';

export interface SqlRunner {
  query(sql: string, parameters?: unknown[]): Promise<unknown>;
}

export interface HeadlessCostCenter {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export const currentHeadCondition = (centerColumn: string, atParameter: string, alias = 'h'): string =>
  `${alias}.cost_center_id = ${centerColumn}
     AND ${alias}.valid_from <= ${atParameter} AND (${alias}.valid_until IS NULL OR ${alias}.valid_until > ${atParameter})`;

export const currentHeadExistsSql = (centerColumn: string, atParameter: string): string =>
  `EXISTS (SELECT 1 FROM cost_center_head h WHERE ${currentHeadCondition(centerColumn, atParameter)})`;

export const costCenterWithoutHeadMessage = (code: string, name: string): string =>
  `El centro ${code} · ${name} no tiene jefe vigente. Asígnele un jefe antes de agregarle activos.`;

export const costCentersWithoutHead = async (
  runner: SqlRunner,
  costCenterIds: ReadonlyArray<string>,
  at: Date = new Date(),
): Promise<HeadlessCostCenter[]> => {
  if (costCenterIds.length === 0) {
    return [];
  }
  return (await runner.query(
    `SELECT cc.id, cc.external_code AS code, cc.name FROM cost_center cc
     WHERE cc.id = ANY($1::uuid[]) AND NOT ${currentHeadExistsSql('cc.id', '$2::timestamptz')}
     ORDER BY cc.external_code`,
    [[...new Set(costCenterIds)], at],
  )) as HeadlessCostCenter[];
};

export const costCenterWithoutHeadError = (center: HeadlessCostCenter, field = 'costCenterId'): ApiException => {
  const message = costCenterWithoutHeadMessage(center.code, center.name);
  return new ApiException(ErrorCode.CostCenterWithoutHead, message, [{ field, message }]);
};

export const assertCostCenterHasHead = async (
  runner: SqlRunner,
  costCenterId: string,
  at: Date = new Date(),
  field = 'costCenterId',
): Promise<void> => {
  const [headless] = await costCentersWithoutHead(runner, [costCenterId], at);
  if (headless) {
    throw costCenterWithoutHeadError(headless, field);
  }
};
