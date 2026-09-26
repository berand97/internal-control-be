import type { RawRow } from '../excel/read-workbook.js';
import { type AssetColumn, normalizeHeader } from '../diagnostics/asset-report-diagnostics.js';

export const IMPORT_TARGETS = ['ASSETS', 'COST_CENTERS', 'PERSONS'] as const;
export type ImportTarget = (typeof IMPORT_TARGETS)[number];

export const UNKNOWN_COST_CENTER_POLICIES = ['quarantine', 'create'] as const;
export type UnknownCostCenterPolicy = (typeof UNKNOWN_COST_CENTER_POLICIES)[number];

/**
 * Qué hace el importador con una celda vacía de la columna (lo que dice la clasificación de
 * ExcelImportService, no una regla nueva): QUARANTINE = la fila no se importa (columna obligatoria en la
 * plantilla); FLAG = se importa con una marca de calidad; NONE = el dato queda vacío.
 */
export type EmptyEffect = 'QUARANTINE' | 'FLAG' | 'NONE';

/** Catálogos que alimentan los desplegables de la plantilla (hoja oculta). */
export const TEMPLATE_CATALOGS = ['COST_CENTERS', 'DOCUMENT_TYPES', 'CATEGORIES', 'PHYSICAL_CONDITIONS'] as const;
export type TemplateCatalog = (typeof TEMPLATE_CATALOGS)[number];

/**
 * Tipo de dato de la columna en la plantilla. code y catalog van con formato de TEXTO en Excel (01979 no se vuelve
 * 1979); date con formato de fecha; number/integer sin formato de texto.
 */
export type FieldKind = 'text' | 'code' | 'catalog' | 'date' | 'number' | 'integer';

export interface ImportField {
  readonly label: string;
  /** La columna debe estar asignada en el mapeo (validación del mapeo, no de cada fila). */
  readonly required: boolean;
  readonly diagnostic?: AssetColumn;
  /** Encabezado exacto de la columna en la plantilla; el importador lo reconoce al subir el archivo. */
  readonly header: string;
  readonly kind: FieldKind;
  readonly catalog?: TemplateCatalog;
  /** Formato esperado, para la hoja de instrucciones. */
  readonly format: string;
  readonly whenEmpty: { readonly effect: EmptyEffect; readonly text: string };
  /** Valor de la fila de ejemplo. En columnas de catálogo se usa el primer valor del catálogo. */
  readonly example?: string | number;
  /** false: el campo se puede mapear desde un Excel cualquiera pero no va en la plantilla. */
  readonly inTemplate?: false;
}

const CATALOG_FORMAT =
  'Elija de la lista (código — nombre); se guarda el código. También se acepta escribir solo el código.';

export const ASSET_IMPORT_FIELDS = {
  legacyAssetId: {
    label: 'Identificador del activo en el origen',
    required: true,
    diagnostic: 'assetId',
    header: 'Identificador del activo',
    kind: 'code',
    format: 'Texto, único por activo. El activo queda con código interno XLS-<identificador>.',
    whenEmpty: {
      effect: 'QUARANTINE',
      text: 'La fila no se importa (ROW_WITHOUT_ASSET_ID). Si se repite en el archivo, ninguna de esas filas se importa (ASSET_ID_DUPLICATED); si ya se importó antes, se omite.',
    },
    example: 'EJEMPLO-0001',
  },
  legacyCode: {
    label: 'Código de barras o código anterior',
    required: false,
    diagnostic: 'barcode',
    header: 'Código de barras',
    kind: 'code',
    format: 'Texto, máx. 50. «TEMP» se importa con la marca BARCODE_TEMP; un código repetido en el archivo, con BARCODE_DUPLICATED.',
    whenEmpty: { effect: 'FLAG', text: 'Se importa con la marca BARCODE_EMPTY.' },
    example: '000123',
  },
  description: {
    label: 'Descripción',
    required: true,
    header: 'Descripción',
    kind: 'text',
    format: 'Texto, máx. 500 (se recorta).',
    whenEmpty: { effect: 'QUARANTINE', text: 'La fila no se importa (REQUIRED_FIELD_MISSING).' },
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
    whenEmpty: {
      effect: 'QUARANTINE',
      text: 'La fila no se importa (COST_CENTER_UNKNOWN). Un código fuera del catálogo tampoco, salvo que en la vista previa se elija crear los centros inexistentes.',
    },
  },
  categoryCode: {
    label: 'Categoría',
    required: false,
    header: 'Categoría',
    kind: 'catalog',
    catalog: 'CATEGORIES',
    format: `${CATALOG_FORMAT} Un valor fuera del catálogo: la fila no se importa (CATEGORY_UNKNOWN).`,
    whenEmpty: { effect: 'FLAG', text: 'Queda en la categoría «Sin clasificar» con la marca CATEGORY_UNASSIGNED.' },
  },
  physicalCondition: {
    label: 'Condición física',
    required: false,
    header: 'Condición física',
    kind: 'catalog',
    catalog: 'PHYSICAL_CONDITIONS',
    format: `${CATALOG_FORMAT} Un valor fuera del catálogo: la fila no se importa (PHYSICAL_CONDITION_INVALID).`,
    whenEmpty: { effect: 'FLAG', text: 'Queda sin verificar con la marca PHYSICAL_CONDITION_UNKNOWN.' },
  },
  model: {
    label: 'Modelo',
    required: false,
    diagnostic: 'model',
    header: 'Modelo',
    kind: 'text',
    format: 'Texto, máx. 150 (se recorta).',
    whenEmpty: { effect: 'NONE', text: 'Queda vacío.' },
    example: 'Latitude 5440',
  },
  serial: {
    label: 'Número de serie',
    required: false,
    diagnostic: 'serial',
    header: 'Número de serie',
    kind: 'code',
    format: 'Texto, máx. 100 (se recorta).',
    whenEmpty: { effect: 'NONE', text: 'Queda vacío.' },
    example: 'SN0001234',
  },
  acquisitionDocument: {
    label: 'Documento de adquisición',
    required: false,
    header: 'Documento de adquisición',
    kind: 'code',
    format: 'Texto, máx. 100 (se recorta). Factura u orden de compra.',
    whenEmpty: { effect: 'NONE', text: 'Queda vacío.' },
    example: 'FV-000123',
  },
  acquisitionDate: {
    label: 'Fecha de compra',
    required: false,
    diagnostic: 'purchaseDate',
    header: 'Fecha de compra',
    kind: 'date',
    format: 'Fecha de Excel (AAAA-MM-DD). Un texto que no sea fecha, o 1970-01-01, se importa sin fecha con la marca ACQUISITION_DATE_INVALID.',
    whenEmpty: { effect: 'FLAG', text: 'Se importa sin fecha con la marca ACQUISITION_DATE_MISSING.' },
    example: '2025-03-14',
  },
  acquisitionPrice: {
    label: 'Precio de compra',
    required: false,
    diagnostic: 'price',
    header: 'Precio de compra',
    kind: 'number',
    format: 'Número en pesos (COP), sin símbolo ni separadores de miles. 0 se importa con la marca PRICE_ZERO.',
    whenEmpty: { effect: 'FLAG', text: 'Se importa con precio 0 y la marca PRICE_MISSING (también si no es un número).' },
    example: 3500000,
  },
  usefulLifeYears: {
    label: 'Vida útil (años)',
    required: false,
    header: 'Vida útil (años)',
    kind: 'integer',
    format: 'Número entero de años (hasta 3 cifras); otro valor se ignora.',
    whenEmpty: { effect: 'NONE', text: 'Queda vacía.' },
    example: 5,
  },
  notes: {
    label: 'Observaciones',
    required: false,
    header: 'Observaciones',
    kind: 'text',
    format: 'Texto libre.',
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
    format: 'Texto. Un código repetido en el archivo no se importa (CODE_DUPLICATED); uno que ya existe se omite.',
    whenEmpty: { effect: 'QUARANTINE', text: 'La fila no se importa (REQUIRED_FIELD_MISSING).' },
    example: 'EJ01',
  },
  name: {
    label: 'Nombre',
    required: true,
    header: 'Nombre',
    kind: 'text',
    format: 'Texto, máx. 200 (se recorta).',
    whenEmpty: { effect: 'QUARANTINE', text: 'La fila no se importa (REQUIRED_FIELD_MISSING).' },
    example: 'EJEMPLO: oficina de ejemplo (fila de ejemplo, se ignora)',
  },
} as const satisfies Record<string, ImportField>;

/**
 * Personas (funcionarios). Identidad por (tipo, número de documento). El nombre va en una sola columna
 * (fullName, se guarda sin partir) o en dos (firstName + lastName), nunca ambas cosas. La plantilla pide el nombre
 * partido; fullName queda para archivos que no lo traen partido.
 */
export const PERSON_IMPORT_FIELDS = {
  documentNumber: {
    label: 'Número de documento',
    required: true,
    header: 'Número de documento',
    kind: 'code',
    format: 'Texto, máx. 30. Con CC o TI, solo dígitos (DOCUMENT_NUMBER_INVALID). Un número repetido en el archivo no se importa (DOCUMENT_NUMBER_DUPLICATED).',
    whenEmpty: { effect: 'QUARANTINE', text: 'La fila no se importa (DOCUMENT_NUMBER_MISSING).' },
    example: '1000000000',
  },
  documentType: {
    label: 'Tipo de documento (CC, CE, PA, PEP, PPT, TI o su abreviatura)',
    required: false,
    header: 'Tipo de documento',
    kind: 'catalog',
    catalog: 'DOCUMENT_TYPES',
    format: `${CATALOG_FORMAT} También la abreviatura impresa (C.C.). Un valor fuera del catálogo: la fila no se importa (DOCUMENT_TYPE_INVALID).`,
    whenEmpty: { effect: 'FLAG', text: 'Se guarda sin tipo, con la marca DOCUMENT_TYPE_UNKNOWN.' },
  },
  fullName: {
    label: 'Nombre completo (una sola columna; se guarda sin partir)',
    required: false,
    header: 'Nombre completo',
    kind: 'text',
    format: 'Texto, máx. 100. Se guarda sin partir con la marca NAME_NOT_SPLIT.',
    whenEmpty: { effect: 'QUARANTINE', text: 'La fila no se importa (REQUIRED_FIELD_MISSING).' },
    inTemplate: false,
  },
  firstName: {
    label: 'Nombres',
    required: false,
    header: 'Nombres',
    kind: 'text',
    format: 'Texto, máx. 100 (más largo: FIELD_TOO_LONG).',
    whenEmpty: { effect: 'QUARANTINE', text: 'La fila no se importa (REQUIRED_FIELD_MISSING).' },
    example: 'EJEMPLO',
  },
  lastName: {
    label: 'Apellidos',
    required: false,
    header: 'Apellidos',
    kind: 'text',
    format: 'Texto, máx. 100 (más largo: FIELD_TOO_LONG).',
    whenEmpty: { effect: 'QUARANTINE', text: 'La fila no se importa (REQUIRED_FIELD_MISSING).' },
    example: 'FILA DE EJEMPLO',
  },
  positionTitle: {
    label: 'Cargo',
    required: false,
    header: 'Cargo',
    kind: 'text',
    format: 'Texto, máx. 150 (más largo: FIELD_TOO_LONG).',
    whenEmpty: { effect: 'NONE', text: 'Queda vacío.' },
    example: 'Cargo de ejemplo',
  },
  email: {
    label: 'Correo institucional (@unac.edu.co)',
    required: false,
    header: 'Correo institucional',
    kind: 'text',
    format: 'Correo terminado en @unac.edu.co; otro dominio: la fila no se importa (EMAIL_NOT_INSTITUTIONAL).',
    whenEmpty: { effect: 'QUARANTINE', text: 'La fila no se importa (EMAIL_MISSING).' },
    example: 'ejemplo.plantilla@unac.edu.co',
  },
  costCenterCode: {
    label: 'Código del centro de costo de adscripción',
    required: false,
    header: 'Centro de costo',
    kind: 'catalog',
    catalog: 'COST_CENTERS',
    format: `${CATALOG_FORMAT} Un código fuera del catálogo: la fila no se importa (COST_CENTER_UNKNOWN).`,
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

/** Reglas del mapeo que no caben en un campo (las aplica targetRuleErrors de ExcelImportService). */
export const TARGET_RULES: Record<ImportTarget, ReadonlyArray<string>> = {
  ASSETS: [],
  COST_CENTERS: [],
  PERSONS: [
    'Nombre: fullName (se guarda sin partir, marca NAME_NOT_SPLIT) o firstName + lastName, no ambos',
    'Tipo de documento: columna documentType o documentType declarado en la vista previa, no ambos',
    'Sin correo institucional la fila va a cuarentena (EMAIL_MISSING / EMAIL_NOT_INSTITUTIONAL)',
    'Centro de costo inexistente: cuarentena (unknownCostCenters=create no aplica)',
  ],
};

export const templateFields = (target: ImportTarget): ReadonlyArray<readonly [string, ImportField]> =>
  Object.entries(fieldsFor(target)).filter(([, field]) => field.inTemplate !== false);

/**
 * Asigna automáticamente las columnas cuyo encabezado es el de la plantilla (sin distinguir mayúsculas, tildes,
 * espacios ni signos). Solo campos de la plantilla; lo demás se mapea a mano como siempre.
 */
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

/** Separador entre código y nombre en los valores de los desplegables («4360 — FINANZAS …»). */
export const CATALOG_SEPARATOR = ' — ';

/**
 * Código de un valor de catálogo: el valor del desplegable («4360 — NOMBRE», también con - o –) o el código solo.
 * Exige espacio antes y después del guion, así que un código con guiones («NO-EXISTE-1») queda entero.
 * Espejo exacto de CATALOG_CODE_SQL.
 */
export const catalogCode = (raw: string): string => {
  const match = /^(\S+)\s+[—–-]\s/.exec(raw);
  return match?.[1] ?? raw;
};

/** La misma regla en SQL, sobre una expresión de texto ya recortada. */
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
