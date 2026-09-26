import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';
import type { RawCellValue } from '../excel/read-workbook.js';
import {
  CATALOG_SEPARATOR,
  type ImportField,
  type ImportTarget,
  TARGET_RULES,
  type TemplateCatalog,
  templateFields,
} from '../import/import-fields.js';

/**
 * Plantillas Excel de importación, generadas desde la definición del importador (import-fields.ts).
 *
 * VERSIÓN E INVALIDACIÓN
 * - versión = identificador de la definición: los 10 primeros hex del SHA-256 de (formato del generador, destino,
 *   campos de la plantilla con encabezado/tipo/formato/regla de vacío/ejemplo, reglas del destino). Cambia si y solo
 *   si cambia lo que el importador espera. No depende de los catálogos ni de la fecha.
 * - contenido = SHA-256 de (hash de la definición + catálogos que alimentan los desplegables). Los catálogos
 *   cambian más seguido que la definición: un centro nuevo produce otro archivo con la MISMA versión.
 * - El archivo se guarda en el storage del sistema y se sirve desde ahí; se regenera solo cuando cambia el hash de
 *   contenido (nunca por tiempo). Ver ImportTemplateService.
 *
 * DENTRO DEL ARCHIVO
 * - Hoja de datos (primera): encabezados exactos en la fila 1, obligatorios en rojo, fila 2 de ejemplo.
 * - Hoja «Instrucciones»: una fila por columna, derivada de la definición.
 * - Hoja oculta «Catalogos»: una columna por catálogo; los desplegables son validaciones de lista contra ella.
 * - Hoja oculta «_plantilla»: pares clave/valor legibles por máquina (formato, destino, versión, hashes, hoja de
 *   datos, fila de encabezados y la fila de ejemplo tal como se escribió).
 * - Sin fórmulas, sin celdas combinadas, sin bloques de resumen.
 */

/** Sube cuando cambia la forma del archivo generado (hojas, marcas): también cambia la versión. */
export const TEMPLATE_LAYOUT = 1;
export const TEMPLATE_MARKER = 'UNAC-CONTROL-INTERNO-PLANTILLA-IMPORTACION';
export const META_SHEET = '_plantilla';
export const CATALOG_SHEET = 'Catalogos';
export const INSTRUCTIONS_SHEET = 'Instrucciones';
export const HEADER_ROW = 1;
export const EXAMPLE_ROW = 2;
/** Filas con desplegable y formato (suficiente para una compra o una carga de personal). */
export const TEMPLATE_ROWS = 5000;
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const DATA_SHEET_NAME: Record<ImportTarget, string> = {
  ASSETS: 'Activos',
  COST_CENTERS: 'Centros de costo',
  PERSONS: 'Personas',
};

const FILE_SLUG: Record<ImportTarget, string> = {
  ASSETS: 'activos',
  COST_CENTERS: 'centros-de-costo',
  PERSONS: 'personas',
};

const CATALOG_TITLE: Record<TemplateCatalog, string> = {
  COST_CENTERS: 'Centros de costo',
  DOCUMENT_TYPES: 'Tipos de documento',
  CATEGORIES: 'Categorías',
  PHYSICAL_CONDITIONS: 'Condiciones físicas',
};

export interface CatalogEntry {
  readonly code: string;
  readonly name: string;
}

export type TemplateCatalogs = Partial<Record<TemplateCatalog, ReadonlyArray<CatalogEntry>>>;

export const catalogValue = (entry: CatalogEntry): string => `${entry.code}${CATALOG_SEPARATOR}${entry.name}`;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export const catalogsUsedBy = (target: ImportTarget): ReadonlyArray<TemplateCatalog> => [
  ...new Set(templateFields(target).flatMap(([, field]) => (field.catalog ? [field.catalog] : []))),
];

export const definitionHash = (target: ImportTarget): string =>
  sha256(
    JSON.stringify({
      layout: TEMPLATE_LAYOUT,
      target,
      fields: templateFields(target).map(([name, field]) => ({
        name,
        header: field.header,
        label: field.label,
        required: field.required,
        kind: field.kind,
        catalog: field.catalog ?? null,
        format: field.format,
        whenEmpty: field.whenEmpty,
        example: field.example ?? null,
      })),
      rules: TARGET_RULES[target],
    }),
  );

export const templateVersion = (target: ImportTarget): string => definitionHash(target).slice(0, 10);

export const contentHash = (target: ImportTarget, catalogs: TemplateCatalogs): string =>
  sha256(
    JSON.stringify({
      definition: definitionHash(target),
      catalogs: catalogsUsedBy(target).map((catalog) => [catalog, catalogs[catalog] ?? []]),
    }),
  );

export const templateFileName = (target: ImportTarget, version: string): string =>
  `plantilla-${FILE_SLUG[target]}-v${version}.xlsx`;

const columnLetter = (index: number): string => {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const rest = (n - 1) % 26;
    letters = String.fromCharCode(65 + rest) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
};

/** Valor de la fila de ejemplo de un campo; en catálogos, el primero del catálogo. */
const exampleValue = (field: ImportField, catalogs: TemplateCatalogs): string | number | Date | null => {
  if (field.catalog) {
    const first = catalogs[field.catalog]?.[0];
    return first ? catalogValue(first) : null;
  }
  if (field.example === undefined) {
    return null;
  }
  if (field.kind === 'date') {
    return new Date(`${String(field.example)}T00:00:00.000Z`);
  }
  return field.example;
};

/** Cómo queda la celda al leerla (readWorkbook): la fila de ejemplo se reconoce comparando con esto. */
const asRead = (value: string | number | Date): RawCellValue =>
  value instanceof Date ? value.toISOString() : value;

const NUM_FMT: Record<ImportField['kind'], string | undefined> = {
  text: '@',
  code: '@',
  catalog: '@',
  date: 'yyyy-mm-dd',
  number: undefined,
  integer: '0',
};

export interface BuildTemplateInput {
  readonly target: ImportTarget;
  readonly catalogs: TemplateCatalogs;
  readonly generatedAt: Date;
}

export interface BuiltTemplate {
  readonly version: string;
  readonly definitionHash: string;
  readonly contentHash: string;
  readonly fileName: string;
  readonly body: Buffer;
}

const REQUIRED_FILL = 'FFC00000';
const OPTIONAL_FILL = 'FFD9D9D9';
const EXAMPLE_FILL = 'FFFFF2CC';

export const buildTemplate = async ({ target, catalogs, generatedAt }: BuildTemplateInput): Promise<BuiltTemplate> => {
  const version = templateVersion(target);
  const definition = definitionHash(target);
  const content = contentHash(target, catalogs);
  const fields = templateFields(target);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Control Interno UNAC';
  workbook.created = generatedAt;
  workbook.modified = generatedAt;
  workbook.title = `Plantilla de importación: ${DATA_SHEET_NAME[target]}`;
  workbook.subject = `Plantilla ${target} versión ${version}`;
  workbook.keywords = `${TEMPLATE_MARKER};${target};${version}`;

  const data = workbook.addWorksheet(DATA_SHEET_NAME[target], {
    views: [{ state: 'frozen', ySplit: HEADER_ROW }],
  });
  const instructions = workbook.addWorksheet(INSTRUCTIONS_SHEET);
  const catalogSheet = workbook.addWorksheet(CATALOG_SHEET, { state: 'hidden' });
  const meta = workbook.addWorksheet(META_SHEET, { state: 'hidden' });

  // Catálogos: una columna por catálogo usado, título en la fila 1 y valores desde la fila 2.
  const catalogRange = new Map<TemplateCatalog, string>();
  catalogsUsedBy(target).forEach((catalog, index) => {
    const letter = columnLetter(index);
    const entries = catalogs[catalog] ?? [];
    catalogSheet.getCell(`${letter}1`).value = CATALOG_TITLE[catalog];
    entries.forEach((entry, row) => {
      const cell = catalogSheet.getCell(`${letter}${row + 2}`);
      cell.numFmt = '@';
      cell.value = catalogValue(entry);
    });
    catalogSheet.getColumn(letter).width = 60;
    if (entries.length > 0) {
      catalogRange.set(catalog, `'${CATALOG_SHEET}'!$${letter}$2:$${letter}$${entries.length + 1}`);
    }
  });

  const example: Record<string, RawCellValue> = {};
  fields.forEach(([, field], index) => {
    const letter = columnLetter(index);
    const column = data.getColumn(letter);
    column.width = Math.max(14, Math.min(48, field.header.length + 6));
    const numFmt = NUM_FMT[field.kind];
    if (numFmt) {
      column.numFmt = numFmt;
    }
    const obligatory = field.whenEmpty.effect === 'QUARANTINE';
    const header = data.getCell(`${letter}${HEADER_ROW}`);
    header.value = field.header;
    header.font = { bold: true, color: { argb: obligatory ? 'FFFFFFFF' : 'FF000000' } };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: obligatory ? REQUIRED_FILL : OPTIONAL_FILL } };
    header.note = `${obligatory ? 'OBLIGATORIA' : 'Opcional'}. ${field.format} Si se deja vacía: ${field.whenEmpty.text}`;

    const value = exampleValue(field, catalogs);
    const cell = data.getCell(`${letter}${EXAMPLE_ROW}`);
    if (value !== null) {
      cell.value = value;
      example[letter] = asRead(value);
    }
    cell.font = { italic: true, color: { argb: 'FF7F7F7F' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: EXAMPLE_FILL } };

    const range = field.catalog ? catalogRange.get(field.catalog) : undefined;
    if (range) {
      data.dataValidations.add(`${letter}${EXAMPLE_ROW}:${letter}${TEMPLATE_ROWS + 1}`, {
        type: 'list',
        allowBlank: true,
        formulae: [range],
        showErrorMessage: true,
        errorStyle: 'warning',
        errorTitle: 'Valor fuera de la lista',
        error: 'Elija un valor de la lista. Escribir solo el código también se acepta.',
      });
    }
  });
  data.getCell(`A${EXAMPLE_ROW}`).note =
    'FILA DE EJEMPLO: el importador la ignora mientras no se modifique. Puede dejarla, borrarla o reemplazarla por un dato real.';

  // Instrucciones: sin combinar celdas; una fila por columna de la plantilla.
  const obligatoryHeaders = fields.filter(([, field]) => field.whenEmpty.effect === 'QUARANTINE');
  const lines = [
    `Plantilla de importación: ${DATA_SHEET_NAME[target]}`,
    `Versión de plantilla: ${version} (generada ${generatedAt.toISOString().slice(0, 10)})`,
    `Llene la hoja «${DATA_SHEET_NAME[target]}». La fila ${EXAMPLE_ROW} es un ejemplo: el importador la ignora mientras no la modifique; puede dejarla o borrarla.`,
    `Encabezados en rojo: obligatorios (${obligatoryHeaders.map(([, field]) => field.header).join(', ')}). Sin ese dato la fila no se importa (queda en cuarentena).`,
    'No cambie los encabezados: así el sistema reconoce las columnas. Si agrega columnas propias, se ignoran y el diagnóstico las reporta como no mapeadas.',
    'Las columnas de códigos tienen formato de texto: los ceros a la izquierda se conservan (01979 sigue siendo 01979).',
    'Los desplegables muestran código y nombre; el sistema guarda el código.',
    ...TARGET_RULES[target].map((rule) => `Regla: ${rule}`),
  ];
  lines.forEach((line, index) => {
    instructions.getCell(`A${index + 1}`).value = line;
  });
  instructions.getCell('A1').font = { bold: true, size: 14 };
  const tableStart = lines.length + 2;
  const tableHeader = ['Columna', 'Campo del sistema', 'Obligatoria', 'Formato', 'Si se deja vacía', 'Valores'];
  tableHeader.forEach((title, index) => {
    const cell = instructions.getCell(`${columnLetter(index)}${tableStart}`);
    cell.value = title;
    cell.font = { bold: true };
  });
  fields.forEach(([name, field], row) => {
    const values = [
      field.header,
      `${name} (${field.label})`,
      field.whenEmpty.effect === 'QUARANTINE' ? 'Sí' : 'No',
      field.format,
      field.whenEmpty.text,
      field.catalog ? `Lista: ${CATALOG_TITLE[field.catalog]} (${catalogs[field.catalog]?.length ?? 0})` : '',
    ];
    values.forEach((value, index) => {
      instructions.getCell(`${columnLetter(index)}${tableStart + row + 1}`).value = value;
    });
  });
  [22, 36, 12, 70, 60, 30].forEach((width, index) => {
    const column = instructions.getColumn(columnLetter(index));
    column.width = width;
    column.alignment = { wrapText: true, vertical: 'top' };
  });

  // Metadatos legibles por máquina (todos texto).
  const metaRows: Array<[string, string]> = [
    ['formato', TEMPLATE_MARKER],
    ['destino', target],
    ['version', version],
    ['hash_definicion', definition],
    ['hash_contenido', content],
    ['hoja_datos', DATA_SHEET_NAME[target]],
    ['fila_encabezados', String(HEADER_ROW)],
    ['fila_ejemplo', String(EXAMPLE_ROW)],
    ['ejemplo', JSON.stringify(example)],
    ['generada', generatedAt.toISOString()],
  ];
  metaRows.forEach(([key, value], index) => {
    meta.getCell(`A${index + 1}`).value = key;
    const cell = meta.getCell(`B${index + 1}`);
    cell.numFmt = '@';
    cell.value = value;
  });

  const body = Buffer.from(await workbook.xlsx.writeBuffer());
  return { version, definitionHash: definition, contentHash: content, fileName: templateFileName(target, version), body };
};

export interface TemplateMarker {
  readonly target: string;
  readonly version: string;
  readonly definitionHash: string;
  readonly dataSheet: string;
  readonly headerRow: number;
  readonly example: Record<string, RawCellValue>;
}

/**
 * Lee la hoja «_plantilla» de un archivo subido (sus filas, como quedan en staging_row). null si no es una
 * plantilla de este sistema: un Excel cualquiera no trae esa hoja con la marca, así que no se ve afectado.
 */
export const readTemplateMarker = (
  rows: ReadonlyArray<{ readonly cells: Record<string, RawCellValue> }>,
): TemplateMarker | null => {
  const values = new Map<string, string>();
  for (const row of rows) {
    const key = row.cells['A'];
    const value = row.cells['B'];
    if (typeof key === 'string' && value !== undefined) {
      values.set(key.trim(), String(value));
    }
  }
  if (values.get('formato') !== TEMPLATE_MARKER) {
    return null;
  }
  const target = values.get('destino');
  const version = values.get('version');
  const dataSheet = values.get('hoja_datos');
  if (!target || !version || !dataSheet) {
    return null;
  }
  let example: Record<string, RawCellValue> = {};
  try {
    const parsed = JSON.parse(values.get('ejemplo') ?? '{}') as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      example = parsed as Record<string, RawCellValue>;
    }
  } catch {
    example = {};
  }
  const headerRow = Number(values.get('fila_encabezados') ?? HEADER_ROW);
  return {
    target,
    version,
    definitionHash: values.get('hash_definicion') ?? '',
    dataSheet,
    headerRow: Number.isInteger(headerRow) && headerRow > 0 ? headerRow : HEADER_ROW,
    example,
  };
};
