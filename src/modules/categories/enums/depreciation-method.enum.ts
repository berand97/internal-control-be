export enum DepreciationMethod {
  StraightLine = 'STRAIGHT_LINE',
  DecliningBalance = 'DECLINING_BALANCE',
  UnitsOfProduction = 'UNITS_OF_PRODUCTION',
  None = 'NONE',
}

export const DEPRECIATION_METHODS = [
  DepreciationMethod.StraightLine,
  DepreciationMethod.DecliningBalance,
  DepreciationMethod.UnitsOfProduction,
  DepreciationMethod.None,
] as const;
