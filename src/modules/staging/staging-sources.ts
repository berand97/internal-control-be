export const STAGING_SOURCE_KINDS = [
  'ASSET_REPORT',
  'COST_CENTERS',
  'EMPLOYEE_CONTRACTS',
] as const;

export type StagingSourceKind = (typeof STAGING_SOURCE_KINDS)[number];

const HEADER_ROWS: Partial<Record<StagingSourceKind, Record<string, number>>> = {
  ASSET_REPORT: { Hoja2: 2 },
  COST_CENTERS: { '2026': 3 },
};

export const headerRowFor = (kind: StagingSourceKind, sheetName: string): number =>
  HEADER_ROWS[kind]?.[sheetName.trim()] ?? 1;

export const isStagingSourceKind = (value: string): value is StagingSourceKind =>
  (STAGING_SOURCE_KINDS as ReadonlyArray<string>).includes(value);
