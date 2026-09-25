import type { RawRow } from '../excel/read-workbook.js';
import type { AssetColumn } from '../diagnostics/asset-report-diagnostics.js';

export const IMPORT_TARGETS = ['ASSETS', 'COST_CENTERS'] as const;
export type ImportTarget = (typeof IMPORT_TARGETS)[number];

export const UNKNOWN_COST_CENTER_POLICIES = ['quarantine', 'create'] as const;
export type UnknownCostCenterPolicy = (typeof UNKNOWN_COST_CENTER_POLICIES)[number];

export interface ImportField {
  readonly label: string;
  readonly required: boolean;
  readonly diagnostic?: AssetColumn;
}

export const ASSET_IMPORT_FIELDS = {
  legacyAssetId: { label: 'Identificador del activo en el origen', required: true, diagnostic: 'assetId' },
  legacyCode: { label: 'Código de barras o código anterior', required: false, diagnostic: 'barcode' },
  description: { label: 'Descripción', required: true },
  costCenterCode: { label: 'Código del centro de costo', required: true, diagnostic: 'costCenter' },
  model: { label: 'Modelo', required: false, diagnostic: 'model' },
  serial: { label: 'Número de serie', required: false, diagnostic: 'serial' },
  acquisitionDocument: { label: 'Documento de adquisición', required: false },
  acquisitionDate: { label: 'Fecha de compra', required: false, diagnostic: 'purchaseDate' },
  acquisitionPrice: { label: 'Precio de compra', required: false, diagnostic: 'price' },
  usefulLifeYears: { label: 'Vida útil (años)', required: false },
  notes: { label: 'Observaciones', required: false },
} as const satisfies Record<string, ImportField>;

export const COST_CENTER_IMPORT_FIELDS = {
  code: { label: 'Código', required: true },
  name: { label: 'Nombre', required: true },
} as const satisfies Record<string, ImportField>;

export type AssetImportField = keyof typeof ASSET_IMPORT_FIELDS;
export type CostCenterImportField = keyof typeof COST_CENTER_IMPORT_FIELDS;

export const fieldsFor = (target: ImportTarget): Record<string, ImportField> =>
  target === 'ASSETS' ? ASSET_IMPORT_FIELDS : COST_CENTER_IMPORT_FIELDS;

export const COLUMN_LETTER = /^[A-Z]{1,3}$/;

export const detectHeaderRow = (rows: ReadonlyArray<RawRow>): number => {
  const candidate = rows
    .slice(0, 30)
    .find((row) => {
      const values = Object.values(row.cells).filter((value) => String(value).trim() !== '');
      return values.length >= 2 && values.every((value) => typeof value === 'string');
    });
  return candidate?.rowNumber ?? 1;
};

export const isImportTarget = (value: string): value is ImportTarget =>
  (IMPORT_TARGETS as ReadonlyArray<string>).includes(value);

export const isUnknownCostCenterPolicy = (value: string): value is UnknownCostCenterPolicy =>
  (UNKNOWN_COST_CENTER_POLICIES as ReadonlyArray<string>).includes(value);
