import type { RawRow } from '../excel/read-workbook.js';
import { IDENTITY_DOCUMENT_TYPE_CODES, IDENTITY_DOCUMENT_TYPES } from '../../../common/identity/identity-document-types.js';
import { type AssetColumn, normalizeHeader } from '../diagnostics/asset-report-diagnostics.js';

export const IMPORT_TARGETS = ['ASSETS', 'COST_CENTERS', 'PERSONS'] as const;
export type ImportTarget = (typeof IMPORT_TARGETS)[number];

export const UNKNOWN_COST_CENTER_POLICIES = ['quarantine', 'create'] as const;
export type UnknownCostCenterPolicy = (typeof UNKNOWN_COST_CENTER_POLICIES)[number];

export const EMPTY_EFFECTS = ['QUARANTINE', 'FLAG', 'NONE'] as const;
export type EmptyEffect = (typeof EMPTY_EFFECTS)[number];

export const TEMPLATE_CATALOGS = ['COST_CENTERS', 'DOCUMENT_TYPES', 'CATEGORIES', 'PHYSICAL_CONDITIONS'] as const;
export type TemplateCatalog = (typeof TEMPLATE_CATALOGS)[number];

export const FIELD_KINDS = ['text', 'code', 'catalog', 'date', 'number', 'integer'] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

export interface ImportField {
  readonly label: string;
  readonly required: boolean;
  readonly diagnostic?: AssetColumn;
  readonly header: string;
  readonly kind: FieldKind;
  readonly catalog?: TemplateCatalog;
  readonly format: string;
  readonly summary: string;
  readonly maxLength?: { readonly length: number; readonly over: 'TRUNCATE' | 'QUARANTINE' };
  readonly whenEmpty: { readonly effect: EmptyEffect; readonly text: string };
  readonly example?: string | number;
  readonly inTemplate?: false;
}

const CATALOG_FORMAT =
  'Elija de la lista o escriba solo el código.';

const cut = (length: number) => ({ length, over: 'TRUNCATE' as const });
const reject = (length: number) => ({ length, over: 'QUARANTINE' as const });

export const IMPORT_TRANSFORMATIONS = ['VALUE_TRUNCATED', 'USEFUL_LIFE_DISCARDED'] as const;
export type ImportTransformationCode = (typeof IMPORT_TRANSFORMATIONS)[number];

export const SAMPLE_ROWS = 3;
export const SAMPLE_CELL_MAX = 60;
export const SAMPLE_COLUMNS_MAX = 60;

export const USEFUL_LIFE_PATTERN = String.raw`^[0-9]{1,3}(\.0+)?$`;

const DOCUMENT_TYPE_LIST = IDENTITY_DOCUMENT_TYPE_CODES.join(', ');
const NUMERIC_DOCUMENT_TYPE_LIST = IDENTITY_DOCUMENT_TYPE_CODES.filter(
  (code) => IDENTITY_DOCUMENT_TYPES[code].numeric,
).join(' o ');

export const ASSET_IMPORT_FIELDS = {
  legacyAssetId: {
    label: 'Identificador del activo en el origen',
    required: true,
    diagnostic: 'assetId',
    header: 'Identificador del activo',
    kind: 'code',
    format: 'Texto. No se puede repetir. El activo queda con el código interno XLS seguido de este valor.',
    summary: 'Único por activo. Si se repite en el archivo, esas filas no se importan.',
    whenEmpty: {
      effect: 'QUARANTINE',
      text: 'La fila no se importa. Si se repite en el archivo, ninguna de esas filas se importa. Si ya se importó antes, se omite.',
    },
    example: 'EJEMPLO-0001',
  },
  legacyCode: {
    label: 'Código de barras o código anterior',
    required: false,
    diagnostic: 'barcode',
    header: 'Código de barras',
    kind: 'code',
    format: 'Texto, hasta 50 caracteres. TEMP o un código repetido se importan marcados para revisión.',
    summary: 'Opcional. Un código TEMP, repetido o vacío se importa marcado para revisión.',
    maxLength: cut(50),
    whenEmpty: { effect: 'FLAG', text: 'Se importa marcado para revisión.' },
    example: '000123',
  },
  description: {
    label: 'Descripción',
    required: true,
    header: 'Descripción',
    kind: 'text',
    format: 'Texto, hasta 500 caracteres. Lo demás se recorta.',
    summary: 'Hasta 500 caracteres. Lo demás se recorta.',
    maxLength: cut(500),
    whenEmpty: { effect: 'QUARANTINE', text: 'La fila no se importa.' },
    example: 'EJEMPLO: portátil 14 pulgadas (fila de ejemplo, se ignora)',
  },
  costCenterCode: {
    label: 'Código del centro de costo',
    required: true,
    diagnostic: 'costCenter',
    header: 'Centro de costo',
    kind: 'catalog',
    catalog: 'COST_CENTERS',
    format: CATALOG_FORMAT,
    summary: 'Debe existir en la lista, salvo que elija crearlo más abajo.',
    whenEmpty: {
      effect: 'QUARANTINE',
      text: 'La fila no se importa. Un código que no está en la lista tampoco.',
    },
  },
  categoryCode: {
    label: 'Categoría',
    required: false,
    header: 'Categoría',
    kind: 'catalog',
    catalog: 'CATEGORIES',
    format: `${CATALOG_FORMAT} Si el valor no está en la lista, la fila no se importa.`,
    summary: 'Una categoría de la lista. Si está vacía, queda Sin clasificar.',
    whenEmpty: { effect: 'FLAG', text: 'Queda en Sin clasificar, marcado para revisión.' },
  },
  physicalCondition: {
    label: 'Condición física',
    required: false,
    header: 'Condición física',
    kind: 'catalog',
    catalog: 'PHYSICAL_CONDITIONS',
    format: `${CATALOG_FORMAT} Si el valor no está en la lista, la fila no se importa.`,
    summary: 'Un estado de la lista. Si está vacío, queda sin verificar.',
    whenEmpty: { effect: 'FLAG', text: 'Queda sin verificar, marcado para revisión.' },
  },
  model: {
    label: 'Modelo',
    required: false,
    diagnostic: 'model',
    header: 'Modelo',
    kind: 'text',
    format: 'Texto, hasta 150 caracteres. Lo demás se recorta.',
    summary: 'Opcional. Hasta 150 caracteres.',
    maxLength: cut(150),
    whenEmpty: { effect: 'NONE', text: 'Queda vacío.' },
    example: 'Latitude 5440',
  },
  serial: {
    label: 'Número de serie',
    required: false,
    diagnostic: 'serial',
    header: 'Número de serie',
    kind: 'code',
    format: 'Texto, hasta 100 caracteres. Lo demás se recorta.',
    summary: 'Opcional. Hasta 100 caracteres.',
    maxLength: cut(100),
    whenEmpty: { effect: 'NONE', text: 'Queda vacío.' },
    example: 'SN0001234',
  },
  acquisitionDocument: {
    label: 'Documento de adquisición',
    required: false,
    header: 'Documento de adquisición',
    kind: 'code',
    format: 'Factura u orden de compra, hasta 100 caracteres. Lo demás se recorta.',
    summary: 'Opcional. Factura u orden de compra.',
    maxLength: cut(100),
    whenEmpty: { effect: 'NONE', text: 'Queda vacío.' },
    example: 'FV-000123',
  },
  acquisitionDate: {
    label: 'Fecha de compra',
    required: false,
    diagnostic: 'purchaseDate',
    header: 'Fecha de compra',
    kind: 'date',
    format: 'Fecha en formato AAAA-MM-DD. Si no es una fecha válida, se importa sin fecha y marcado para revisión.',
    summary: 'Una fecha. Si falta o no es fecha, se importa marcada para revisión.',
    whenEmpty: { effect: 'FLAG', text: 'Se importa sin fecha, marcado para revisión.' },
    example: '2025-03-14',
  },
  acquisitionPrice: {
    label: 'Precio de compra',
    required: false,
    diagnostic: 'price',
    header: 'Precio de compra',
    kind: 'number',
    format: 'Número en pesos, sin símbolo ni puntos de miles. Un 0 se importa marcado para revisión.',
    summary: 'Número en pesos, sin símbolo ni puntos de miles.',
    whenEmpty: { effect: 'FLAG', text: 'Se importa con precio 0, marcado para revisión. Igual si no es un número.' },
    example: 3500000,
  },
  usefulLifeYears: {
    label: 'Vida útil (años)',
    required: false,
    header: 'Vida útil (años)',
    kind: 'integer',
    format: 'Número entero de años, hasta 3 cifras. Otro valor se ignora.',
    summary: 'Opcional. Número entero de años.',
    whenEmpty: { effect: 'NONE', text: 'Queda vacía.' },
    example: 5,
  },
  notes: {
    label: 'Observaciones',
    required: false,
    header: 'Observaciones',
    kind: 'text',
    format: 'Texto libre.',
    summary: 'Opcional. Texto libre.',
    whenEmpty: { effect: 'NONE', text: 'Queda vacío.' },
    example: 'Fila de ejemplo',
  },
} as const satisfies Record<string, ImportField>;

export const COST_CENTER_IMPORT_FIELDS = {
  code: {
    label: 'Código',
    required: true,
    header: 'Código',
    kind: 'code',
    format:
      'Texto. Un código repetido en el archivo no se importa. Uno que ya existe se omite. Si elige actualizar la estructura, se actualizan su centro padre, su dependencia y su movimiento, pero no su código ni su nombre.',
    summary: 'No se puede repetir en el archivo. Si ya existe, se omite o se actualiza su estructura.',
    whenEmpty: { effect: 'QUARANTINE', text: 'La fila no se importa.' },
    example: 'EJ01',
  },
  name: {
    label: 'Nombre',
    required: true,
    header: 'Nombre',
    kind: 'text',
    format: 'Texto, hasta 200 caracteres. Lo demás se recorta.',
    summary: 'Hasta 200 caracteres. Lo demás se recorta.',
    maxLength: cut(200),
    whenEmpty: { effect: 'QUARANTINE', text: 'La fila no se importa.' },
    example: 'EJEMPLO: oficina de ejemplo (fila de ejemplo, se ignora)',
  },
  movement: {
    label: 'Movimiento (1 recibe movimientos, 0 agrupador)',
    required: false,
    header: 'Movimiento',
    kind: 'integer',
    format:
      '1 si recibe activos, 0 si es agrupador. Con otro valor la fila no se importa. Un código de un dígito siempre es agrupador.',
    summary: '1 recibe movimientos, 0 es agrupador. Vacío cuenta como 1.',
    whenEmpty: { effect: 'NONE', text: 'Se toma como 1.' },
    example: 1,
  },
  unitCode: {
    label: 'Código de la dependencia',
    required: false,
    header: 'Unidad',
    kind: 'code',
    format:
      'Código interno de una dependencia existente. Tiene prioridad sobre la dependencia que sale del código del centro. Si no existe, la fila no se importa.',
    summary: 'Opcional. Debe ser una dependencia existente.',
    whenEmpty: {
      effect: 'NONE',
      text: 'Si elige actualizar la estructura, la dependencia sale del código del centro. Si no hay, conserva la que tenga.',
    },
  },
} as const satisfies Record<string, ImportField>;

export const PERSON_IMPORT_FIELDS = {
  documentNumber: {
    label: 'Número de documento',
    required: true,
    header: 'Número de documento',
    kind: 'code',
    format: 'Texto, hasta 30 caracteres. Con CC o TI, solo números. Un número repetido en el archivo no se importa.',
    summary: `Con ${NUMERIC_DOCUMENT_TYPE_LIST}, solo números. No se puede repetir en el archivo.`,
    maxLength: reject(30),
    whenEmpty: { effect: 'QUARANTINE', text: 'La fila no se importa.' },
    example: '1000000000',
  },
  documentType: {
    label: 'Tipo de documento (CC, CE, PA, PEP, PPT, TI o su abreviatura)',
    required: false,
    header: 'Tipo de documento',
    kind: 'catalog',
    catalog: 'DOCUMENT_TYPES',
    format: `${CATALOG_FORMAT} También sirve la abreviatura, como C.C. Si el valor no está en la lista, la fila no se importa.`,
    summary: `Un tipo de la lista (${DOCUMENT_TYPE_LIST}) o su abreviatura.`,
    whenEmpty: { effect: 'FLAG', text: 'Se guarda sin tipo, marcado para revisión.' },
  },
  fullName: {
    label: 'Nombre completo (una sola columna)',
    required: false,
    header: 'Nombre completo',
    kind: 'text',
    format: 'Texto, hasta 100 caracteres. Se guarda sin separar nombres y apellidos.',
    summary: 'Nombre y apellidos en una sola columna. Se guarda sin separar.',
    maxLength: reject(100),
    whenEmpty: { effect: 'QUARANTINE', text: 'La fila no se importa.' },
    inTemplate: false,
  },
  firstName: {
    label: 'Nombres',
    required: false,
    header: 'Nombres',
    kind: 'text',
    format: 'Texto, hasta 100 caracteres. Si es más largo, la fila no se importa.',
    summary: 'Hasta 100 caracteres.',
    maxLength: reject(100),
    whenEmpty: { effect: 'QUARANTINE', text: 'La fila no se importa.' },
    example: 'EJEMPLO',
  },
  lastName: {
    label: 'Apellidos',
    required: false,
    header: 'Apellidos',
    kind: 'text',
    format: 'Texto, hasta 100 caracteres. Si es más largo, la fila no se importa.',
    summary: 'Hasta 100 caracteres.',
    maxLength: reject(100),
    whenEmpty: { effect: 'QUARANTINE', text: 'La fila no se importa.' },
    example: 'FILA DE EJEMPLO',
  },
  positionTitle: {
    label: 'Cargo',
    required: false,
    header: 'Cargo',
    kind: 'text',
    format: 'Texto, hasta 150 caracteres. Si es más largo, la fila no se importa.',
    summary: 'Opcional. Hasta 150 caracteres.',
    maxLength: reject(150),
    whenEmpty: { effect: 'NONE', text: 'Queda vacío.' },
    example: 'Cargo de ejemplo',
  },
  email: {
    label: 'Correo institucional (@unac.edu.co)',
    required: false,
    header: 'Correo institucional',
    kind: 'text',
    format: 'Correo terminado en @unac.edu.co. Con otro dominio la fila no se importa.',
    summary: 'El correo debe terminar en @unac.edu.co.',
    whenEmpty: { effect: 'QUARANTINE', text: 'La fila no se importa.' },
    example: 'ejemplo.plantilla@unac.edu.co',
  },
  costCenterCode: {
    label: 'Código del centro de costo de adscripción',
    required: false,
    header: 'Centro de costo',
    kind: 'catalog',
    catalog: 'COST_CENTERS',
    format: `${CATALOG_FORMAT} Si el código no está en la lista, la fila no se importa.`,
    summary: 'Opcional. Debe existir en la lista de centros de costo.',
    whenEmpty: { effect: 'NONE', text: 'La persona queda sin centro de costo.' },
  },
} as const satisfies Record<string, ImportField>;

export type AssetImportField = keyof typeof ASSET_IMPORT_FIELDS;
export type CostCenterImportField = keyof typeof COST_CENTER_IMPORT_FIELDS;

const FIELDS_BY_TARGET: Record<ImportTarget, Record<string, ImportField>> = {
  ASSETS: ASSET_IMPORT_FIELDS,
  COST_CENTERS: COST_CENTER_IMPORT_FIELDS,
  PERSONS: PERSON_IMPORT_FIELDS,
};

export const fieldsFor = (target: ImportTarget): Record<string, ImportField> => FIELDS_BY_TARGET[target];

export const TARGET_RULES: Record<ImportTarget, ReadonlyArray<string>> = {
  ASSETS: [
    'Si el centro de costo no tiene jefe, la fila no se importa. Asígnele un jefe y vuelva a importar.',
    'Si el centro de costo no está en la lista, la fila no se importa.',
  ],
  COST_CENTERS: [
    'Por defecto se agregan los códigos nuevos y se omiten los que ya existen. Si elige actualizar la estructura, también se actualizan el centro padre, la dependencia y el movimiento de los existentes.',
    'Nunca se cambia el código ni el nombre de un centro existente. Los centros que no vienen en el archivo no se desactivan.',
    'El centro padre sale del código. Por ejemplo, el padre de 4315 es 4310, 4300, 4000 o 4, el primero que exista.',
    'Un código de un dígito es agrupador y queda como dependencia con el nombre de la fila. Los demás centros toman la dependencia que corresponde a su código o la de la columna Unidad.',
    'Un centro con activos no pasa a agrupador. La columna Responsable no se importa. Los jefes se asignan en Jefes de centro de costo.',
  ],
  PERSONS: [
    'Use Nombre completo o Nombres y Apellidos, no ambos.',
    'El tipo de documento viene de su columna o se elige en la vista previa, no ambos.',
    'Sin correo institucional la fila no se importa.',
    'Si el centro de costo no existe, la fila no se importa.',
  ],
};

export const templateFields = (target: ImportTarget): ReadonlyArray<readonly [string, ImportField]> =>
  Object.entries(fieldsFor(target)).filter(([, field]) => field.inTemplate !== false);

export const recognizeColumns = (
  target: ImportTarget,
  columns: Readonly<Record<string, string>>,
): Record<string, string> => {
  const byHeader = new Map<string, string>();
  for (const [letter, header] of Object.entries(columns)) {
    const key = normalizeHeader(header);
    if (key !== '' && !byHeader.has(key)) {
      byHeader.set(key, letter);
    }
  }
  const mapping: Record<string, string> = {};
  for (const [field, definition] of templateFields(target)) {
    const letter = byHeader.get(normalizeHeader(definition.header));
    if (letter) {
      mapping[field] = letter;
    }
  }
  return mapping;
};

export const CATALOG_SEPARATOR = ' — ';

export const catalogCode = (raw: string): string => {
  const match = /^(\S+)\s+[—–-]\s/.exec(raw);
  return match?.[1] ?? raw;
};

export const catalogCodeSql = (expression: string): string =>
  `coalesce(substring(${expression} from '^(\\S+)\\s+[—–-]\\s'), ${expression})`;

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
