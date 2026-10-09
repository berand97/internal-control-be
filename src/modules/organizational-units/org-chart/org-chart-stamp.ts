import { createHash } from 'node:crypto';
import type ExcelJS from 'exceljs';
import type { RawSheet } from '../../staging/excel/read-workbook.js';
import { parseUnitColor } from '../domain/unit-color.js';
import {
  cellText,
  normalizeText,
  type SnapshotUnit,
  STATUS_ACTIVE,
  STATUS_ARCHIVED,
  UNIT_HEADERS,
  type UnitRowInput,
} from './org-chart.types.js';

/**
 * Sello del Excel del organigrama: hoja «_sello» oculta (veryHidden: no aparece en Mostrar hojas) y protegida.
 *
 * Guarda la versión del formato, el tipo de libro (exportación o plantilla), la hora exacta de la exportación, la
 * revisión de la estructura (hash del estado de todas las unidades) y, por cada fila exportada, su Código interno con
 * la huella (hash) de cada columna editable tal como se escribió. Con eso, al subir el archivo se sabe qué columnas
 * cambió la persona (merge de tres vías: org-chart-merge.ts). La huella no es una firma: solo protege de errores.
 */

export const STAMP_SHEET = '_sello';
export const STAMP_FORMAT_VERSION = 1;

export type StampKind = 'EXPORT' | 'TEMPLATE';

/**
 * Columnas editables con huella (Acción no: siempre sale vacía). Van en este orden en la hoja «_sello»: una columna
 * nueva se agrega al final.
 */
export const STAMP_COLUMNS = ['prefix', 'name', 'type', 'parent', 'relation', 'headCenter', 'status', 'color'] as const;
export type StampColumn = (typeof STAMP_COLUMNS)[number];

/**
 * Columnas que los sellos viejos no traen (se agregaron después): sin huella ('') la columna se trata como en un archivo
 * sin sello (se aplica si dice algo distinto del sistema; vacía no cambia nada).
 */
export const LATER_STAMP_COLUMNS: ReadonlySet<StampColumn> = new Set<StampColumn>(['color']);

export type StampValues = Readonly<Record<StampColumn, string | null>>;

export interface StampRow {
  readonly code: string;
  /**
   * Huella de cada columna con el valor que traía el archivo al descargarlo. '' (o ausente, en previsualizaciones
   * guardadas antes) en una columna de LATER_STAMP_COLUMNS: el sello es anterior a esa columna.
   */
  readonly columns: Readonly<Record<StampColumn, string>>;
}

export interface OrgChartStamp {
  readonly formatVersion: number;
  readonly kind: StampKind;
  /** Hora exacta de la exportación (ISO, con milisegundos). */
  readonly exportedAt: string;
  /** Revisión de la estructura al exportar (structureRevision). */
  readonly revision: string;
  readonly rows: ReadonlyArray<StampRow>;
}

export const STAMP_COLUMN_HEADERS: Readonly<Record<StampColumn, string>> = {
  prefix: UNIT_HEADERS.prefix,
  name: UNIT_HEADERS.name,
  type: UNIT_HEADERS.type,
  parent: UNIT_HEADERS.parent,
  relation: UNIT_HEADERS.relation,
  headCenter: UNIT_HEADERS.headCenter,
  status: UNIT_HEADERS.status,
  color: UNIT_HEADERS.color,
};

/**
 * Valor comparable de una celda: el Nombre sin espacios al borde (distingue mayúsculas: renombrar «contabilidad» a
 * «Contabilidad» es un cambio); el Color como se guarda (#DE9927, DE9927 y #de9927 son el mismo); el resto sin tildes,
 * minúsculas y con espacios compactados (como se interpretan).
 */
export const comparableValue = (column: StampColumn, text: string | null | undefined): string => {
  if (text === null || text === undefined) {
    return '';
  }
  if (column === 'name') {
    return String(text).trim();
  }
  const compact = cellText(text);
  if (column === 'color' && compact) {
    return parseUnitColor(compact) ?? normalizeText(compact);
  }
  return compact ? normalizeText(compact) : '';
};

export const fingerprint = (column: StampColumn, text: string | null | undefined): string =>
  createHash('sha256').update(`${column}\u0000${comparableValue(column, text)}`).digest('hex').slice(0, 16);

export const sameValue = (column: StampColumn, left: string | null | undefined, right: string | null | undefined): boolean =>
  comparableValue(column, left) === comparableValue(column, right);

export const rowValues = (row: UnitRowInput): StampValues => ({
  prefix: row.prefix,
  name: row.name,
  type: row.type,
  parent: row.parent,
  relation: row.relation,
  headCenter: row.headCenter,
  status: row.status,
  color: row.color ?? null,
});

export const statusText = (isActive: boolean): string => (isActive ? STATUS_ACTIVE : STATUS_ARCHIVED);

export const stampRow = (code: string, values: StampValues): StampRow => ({
  code,
  columns: Object.fromEntries(STAMP_COLUMNS.map((column) => [column, fingerprint(column, values[column])])) as Record<
    StampColumn,
    string
  >,
});

/** Revisión exacta de la estructura: hash de todos los campos de todas las unidades (orden estable por id). */
export const structureRevision = (units: ReadonlyArray<SnapshotUnit>): string =>
  createHash('sha256')
    .update(
      JSON.stringify(
        [...units]
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((unit) => [
            unit.id,
            unit.code,
            unit.name,
            unit.unitType,
            unit.parentId,
            unit.relationType,
            unit.headCostCenterId,
            unit.headCostCenterCode,
            unit.codePrefix,
            unit.isActive,
            unit.color ?? null,
          ]),
      ),
    )
    .digest('hex');

// ─── Hoja «_sello» ─────────────────────────────────────────────────────────────────────────────────────────────────

const META_ROWS = 4;
const TABLE_HEADER_ROW = 6;
const TABLE_COLUMNS = ['code', ...STAMP_COLUMNS] as const;

const letter = (index: number): string => String.fromCharCode(65 + index);

export const writeStampSheet = async (workbook: ExcelJS.Workbook, stamp: OrgChartStamp): Promise<void> => {
  const sheet = workbook.addWorksheet(STAMP_SHEET, { state: 'veryHidden' });
  const meta: ReadonlyArray<[string, string]> = [
    ['formatVersion', String(stamp.formatVersion)],
    ['kind', stamp.kind],
    ['exportedAt', stamp.exportedAt],
    ['revision', stamp.revision],
  ];
  meta.forEach(([key, value], index) => {
    sheet.getCell(`A${index + 1}`).value = key;
    sheet.getCell(`B${index + 1}`).value = value;
  });
  TABLE_COLUMNS.forEach((column, index) => {
    sheet.getCell(`${letter(index)}${TABLE_HEADER_ROW}`).value = column;
  });
  stamp.rows.forEach((row, rowIndex) => {
    const at = TABLE_HEADER_ROW + 1 + rowIndex;
    sheet.getCell(`A${at}`).value = row.code;
    STAMP_COLUMNS.forEach((column, index) => {
      sheet.getCell(`${letter(index + 1)}${at}`).value = row.columns[column];
    });
  });
  await sheet.protect('', { selectLockedCells: false, selectUnlockedCells: false });
};

export type StampReading =
  | { readonly status: 'NONE' }
  | { readonly status: 'INVALID' }
  | { readonly status: 'OK'; readonly stamp: OrgChartStamp };

const text = (value: string | number | boolean | undefined): string | null =>
  value === undefined ? null : String(value).trim() || null;

/** Lee la hoja «_sello»; INVALID si está dañada o es de un formato que no se conoce. */
export const readStampSheet = (sheets: ReadonlyArray<RawSheet>): StampReading => {
  const sheet = sheets.find((candidate) => candidate.name === STAMP_SHEET);
  if (!sheet) {
    return { status: 'NONE' };
  }
  const byRow = new Map(sheet.rows.map((row) => [row.rowNumber, row.cells]));
  const meta = new Map<string, string>();
  for (let rowNumber = 1; rowNumber <= META_ROWS; rowNumber += 1) {
    const cells = byRow.get(rowNumber);
    const key = text(cells?.['A']);
    const value = text(cells?.['B']);
    if (key && value) {
      meta.set(key, value);
    }
  }
  const formatVersion = Number(meta.get('formatVersion'));
  const kind = meta.get('kind');
  const exportedAt = meta.get('exportedAt') ?? '';
  const revision = meta.get('revision') ?? '';
  if (
    formatVersion !== STAMP_FORMAT_VERSION ||
    (kind !== 'EXPORT' && kind !== 'TEMPLATE') ||
    Number.isNaN(Date.parse(exportedAt)) ||
    !revision
  ) {
    return { status: 'INVALID' };
  }
  const rows: StampRow[] = [];
  for (const row of sheet.rows) {
    if (row.rowNumber <= TABLE_HEADER_ROW) {
      continue;
    }
    const code = text(row.cells['A']);
    if (!code) {
      continue;
    }
    const columns = Object.fromEntries(
      STAMP_COLUMNS.map((column, index) => [column, text(row.cells[letter(index + 1)]) ?? '']),
    ) as Record<StampColumn, string>;
    if (
      STAMP_COLUMNS.some(
        (column) =>
          !/^[0-9a-f]{16}$/.test(columns[column]) && !(LATER_STAMP_COLUMNS.has(column) && columns[column] === ''),
      )
    ) {
      return { status: 'INVALID' };
    }
    rows.push({ code, columns });
  }
  return { status: 'OK', stamp: { formatVersion, kind, exportedAt: new Date(exportedAt).toISOString(), revision, rows } };
};
