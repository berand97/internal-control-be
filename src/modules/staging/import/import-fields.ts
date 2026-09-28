import type { RawRow } from '../excel/read-workbook.js';
import { IDENTITY_DOCUMENT_TYPE_CODES, IDENTITY_DOCUMENT_TYPES } from '../../../common/identity/identity-document-types.js';
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
export const EMPTY_EFFECTS = ['QUARANTINE', 'FLAG', 'NONE'] as const;
export type EmptyEffect = (typeof EMPTY_EFFECTS)[number];

/** Catálogos que alimentan los desplegables de la plantilla (hoja oculta). */
export const TEMPLATE_CATALOGS = ['COST_CENTERS', 'DOCUMENT_TYPES', 'CATEGORIES', 'PHYSICAL_CONDITIONS'] as const;
export type TemplateCatalog = (typeof TEMPLATE_CATALOGS)[number];

/**
 * Tipo de dato de la columna en la plantilla. code y catalog van con formato de TEXTO en Excel (01979 no se vuelve
 * 1979); date con formato de fecha; number/integer sin formato de texto.
 */
export const FIELD_KINDS = ['text', 'code', 'catalog', 'date', 'number', 'integer'] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

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
  /**
   * Una línea en lenguaje llano, sin códigos de error, que el asistente muestra bajo el campo
   * (GET /imports/targets/{target}/fields → summary). Los límites salen de las mismas constantes que aplica el
   * importador: la pantalla no puede describir una regla distinta a la que se ejecuta.
   */
  readonly summary: string;
  /**
   * Largo máximo que se guarda. TRUNCATE: el importador recorta con left() y la vista previa lo cuenta
   * (VALUE_TRUNCATED); QUARANTINE: la fila no se importa (lo decide la clasificación).
   */
  readonly maxLength?: { readonly length: number; readonly over: 'TRUNCATE' | 'QUARANTINE' };
  readonly whenEmpty: { readonly effect: EmptyEffect; readonly text: string };
  /** Valor de la fila de ejemplo. En columnas de catálogo se usa el primer valor del catálogo. */
  readonly example?: string | number;
  /** false: el campo se puede mapear desde un Excel cualquiera pero no va en la plantilla. */
  readonly inTemplate?: false;
}

const CATALOG_FORMAT =
  'Elija de la lista (código — nombre); se guarda el código. También se acepta escribir solo el código.';

/**
 * Largos que el importador recorta (left() en insertAssets / insertCostCenters) o que mandan la fila a cuarentena
 * (classifyPersons). Son los de las columnas de la base; el SQL y los textos los leen de aquí.
 */
const cut = (length: number) => ({ length, over: 'TRUNCATE' as const });
const reject = (length: number) => ({ length, over: 'QUARANTINE' as const });

/**
 * Cambios que el importador hace sobre un dato que sí se importa, sin mandar la fila a cuarentena ni marcarla. La
 * vista previa los cuenta (summary.transformations) y los lista por fila (problemas con el mismo código).
 * VALUE_TRUNCATED: texto más largo que el campo, se guarda recortado. USEFUL_LIFE_DISCARDED: la vida útil no es un
 * entero de años, el activo queda sin vida útil.
 */
export const IMPORT_TRANSFORMATIONS = ['VALUE_TRUNCATED', 'USEFUL_LIFE_DISCARDED'] as const;
export type ImportTransformationCode = (typeof IMPORT_TRANSFORMATIONS)[number];

/**
 * Muestra de filas al subir el archivo (datos personales, Ley 1581): pocas filas, celdas recortadas y solo las
 * columnas con encabezado. Viaja únicamente en la respuesta HTTP de POST /imports; no se guarda, no se registra en
 * logs ni en audit_log, y el SQL que la lee lleva los valores como resultado, nunca en el texto de la consulta.
 */
export const SAMPLE_ROWS = 3;
export const SAMPLE_CELL_MAX = 60;
/** Tope de columnas de la muestra: una hoja con miles de encabezados no infla la respuesta. */
export const SAMPLE_COLUMNS_MAX = 60;

/** Vida útil que se guarda: entero de hasta 3 cifras (5 o 5.0); cualquier otro valor se descarta. */
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
    format: 'Texto, único por activo. El activo queda con código interno XLS-<identificador>.',
    summary: 'Único por activo. Si se repite en el archivo, esas filas no se importan.',
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
    summary: 'Opcional. Un código TEMP, repetido o vacío se importa marcado para revisión.',
    maxLength: cut(50),
    whenEmpty: { effect: 'FLAG', text: 'Se importa con la marca BARCODE_EMPTY.' },
    example: '000123',
  },
  description: {
    label: 'Descripción',
    required: true,
    header: 'Descripción',
    kind: 'text',
    format: 'Texto, máx. 500 (se recorta).',
    summary: 'Hasta 500 caracteres; lo que pase de ahí se recorta.',
    maxLength: cut(500),
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
    summary: 'Debe existir en el catálogo, salvo que elijas crearlo más abajo.',
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
    summary: 'Una categoría de la lista. Vacía, queda «Sin clasificar».',
    whenEmpty: { effect: 'FLAG', text: 'Queda en la categoría «Sin clasificar» con la marca CATEGORY_UNASSIGNED.' },
  },
  physicalCondition: {
    label: 'Condición física',
    required: false,
    header: 'Condición física',
    kind: 'catalog',
    catalog: 'PHYSICAL_CONDITIONS',
    format: `${CATALOG_FORMAT} Un valor fuera del catálogo: la fila no se importa (PHYSICAL_CONDITION_INVALID).`,
    summary: 'Un estado de la lista. Vacío, queda sin verificar.',
    whenEmpty: { effect: 'FLAG', text: 'Queda sin verificar con la marca PHYSICAL_CONDITION_UNKNOWN.' },
  },
  model: {
    label: 'Modelo',
    required: false,
    diagnostic: 'model',
    header: 'Modelo',
    kind: 'text',
    format: 'Texto, máx. 150 (se recorta).',
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
    format: 'Texto, máx. 100 (se recorta).',
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
    format: 'Texto, máx. 100 (se recorta). Factura u orden de compra.',
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
    format: 'Fecha de Excel (AAAA-MM-DD). Un texto que no sea fecha, o 1970-01-01, se importa sin fecha con la marca ACQUISITION_DATE_INVALID.',
    summary: 'Una fecha. Si falta o no es fecha, se importa marcada para revisión.',
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
    summary: 'Número en pesos, sin símbolo ni puntos de miles.',
    whenEmpty: { effect: 'FLAG', text: 'Se importa con precio 0 y la marca PRICE_MISSING (también si no es un número).' },
    example: 3500000,
  },
  usefulLifeYears: {
    label: 'Vida útil (años)',
    required: false,
    header: 'Vida útil (años)',
    kind: 'integer',
    format: 'Número entero de años (hasta 3 cifras); otro valor se ignora.',
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
      'Texto. Un código repetido en el archivo no se importa (CODE_DUPLICATED); uno que ya existe se omite (con «actualizar estructura» se actualizan su padre, unidad y movimiento, nunca su código ni su nombre).',
    summary: 'No puede repetirse en el archivo; si ya existe, se omite o se actualiza su estructura.',
    whenEmpty: { effect: 'QUARANTINE', text: 'La fila no se importa (REQUIRED_FIELD_MISSING).' },
    example: 'EJ01',
  },
  name: {
    label: 'Nombre',
    required: true,
    header: 'Nombre',
    kind: 'text',
    format: 'Texto, máx. 200 (se recorta).',
    summary: 'Hasta 200 caracteres; lo que pase de ahí se recorta.',
    maxLength: cut(200),
    whenEmpty: { effect: 'QUARANTINE', text: 'La fila no se importa (REQUIRED_FIELD_MISSING).' },
    example: 'EJEMPLO: oficina de ejemplo (fila de ejemplo, se ignora)',
  },
  movement: {
    label: 'Movimiento (1 recibe movimientos, 0 agrupador)',
    required: false,
    header: 'Movimiento',
    kind: 'integer',
    format:
      '1 = recibe movimientos; 0 = nodo agrupador (no recibe activos). Otro valor: la fila no se importa (MOVEMENT_INVALID). Un código de un dígito siempre es agrupador.',
    summary: '1 recibe movimientos, 0 es agrupador. Vacío cuenta como 1.',
    whenEmpty: { effect: 'NONE', text: 'Se toma 1 (recibe movimientos).' },
    example: 1,
  },
  unitCode: {
    label: 'Código de la unidad organizacional',
    required: false,
    header: 'Unidad',
    kind: 'code',
    format:
      'Código de una unidad existente (el de Unidades organizacionales). Manda sobre la unidad que sale del prefijo del código. Un código que no existe: la fila no se importa (UNIT_UNKNOWN).',
    summary: 'Opcional. Si viene, debe ser una unidad existente.',
    whenEmpty: {
      effect: 'NONE',
      text: 'Con «actualizar estructura», la unidad sale del prefijo del código; si no hay, el centro conserva la que tenga.',
    },
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
    summary: `Con ${NUMERIC_DOCUMENT_TYPE_LIST}, solo dígitos. No puede repetirse en el archivo.`,
    maxLength: reject(30),
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
    summary: `Un tipo de la lista (${DOCUMENT_TYPE_LIST}) o su abreviatura.`,
    whenEmpty: { effect: 'FLAG', text: 'Se guarda sin tipo, con la marca DOCUMENT_TYPE_UNKNOWN.' },
  },
  fullName: {
    label: 'Nombre completo (una sola columna; se guarda sin partir)',
    required: false,
    header: 'Nombre completo',
    kind: 'text',
    format: 'Texto, máx. 100. Se guarda sin partir con la marca NAME_NOT_SPLIT.',
    summary: 'Nombre y apellidos en una sola columna; se guarda sin separar.',
    maxLength: reject(100),
    whenEmpty: { effect: 'QUARANTINE', text: 'La fila no se importa (REQUIRED_FIELD_MISSING).' },
    inTemplate: false,
  },
  firstName: {
    label: 'Nombres',
    required: false,
    header: 'Nombres',
    kind: 'text',
    format: 'Texto, máx. 100 (más largo: FIELD_TOO_LONG).',
    summary: 'Hasta 100 caracteres.',
    maxLength: reject(100),
    whenEmpty: { effect: 'QUARANTINE', text: 'La fila no se importa (REQUIRED_FIELD_MISSING).' },
    example: 'EJEMPLO',
  },
  lastName: {
    label: 'Apellidos',
    required: false,
    header: 'Apellidos',
    kind: 'text',
    format: 'Texto, máx. 100 (más largo: FIELD_TOO_LONG).',
    summary: 'Hasta 100 caracteres.',
    maxLength: reject(100),
    whenEmpty: { effect: 'QUARANTINE', text: 'La fila no se importa (REQUIRED_FIELD_MISSING).' },
    example: 'FILA DE EJEMPLO',
  },
  positionTitle: {
    label: 'Cargo',
    required: false,
    header: 'Cargo',
    kind: 'text',
    format: 'Texto, máx. 150 (más largo: FIELD_TOO_LONG).',
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
    format: 'Correo terminado en @unac.edu.co; otro dominio: la fila no se importa (EMAIL_NOT_INSTITUTIONAL).',
    summary: 'El correo debe terminar en @unac.edu.co.',
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
    summary: 'Opcional. Si viene, debe existir en el catálogo de centros de costo.',
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
  COST_CENTERS: [
    'Modo (structureMode): INSERT_ONLY (por defecto) solo inserta los códigos nuevos; UPDATE_STRUCTURE además actualiza padre, unidad y movimiento de los existentes (requiere cost_center:manage:global). Nunca cambia código ni nombre de un existente (un nombre distinto se lista, NAME_DIFFERS) ni desactiva los que no vienen',
    'Padre (UPDATE_STRUCTURE): se deriva del código, el primero que exista en el archivo o en el sistema entre XYZ0 (si es agrupador y no es el propio código), XY00, X000 y X; no se usan los nombres',
    'Unidad (UPDATE_STRUCTURE): un código de un dígito es agrupador y crea o asocia la unidad CC_<dígito> (VICERECTORATE) con ese prefijo y el nombre de la fila; los demás toman la unidad del prefijo o la de la columna de unidad. Un prefijo sin unidad deja esos centros sin unidad (PREFIX_WITHOUT_UNIT)',
    'Un existente con activos no pasa a agrupador (GROUPING_HAS_ASSETS); la columna RESPONSABLE no se importa (los jefes se asignan en Jefes de centro de costo)',
  ],
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
