import { writeFile } from 'node:fs/promises';
import { csvCell } from '../../../common/csv/csv-cell.js';
import type { Issue } from '../diagnostics/asset-report-diagnostics.js';

export const ISSUE_DESCRIPTIONS: Record<string, string> = {
  MISSING_COLUMN: 'Falta esta columna en el encabezado.',
  EMPTY_ROW: 'Fila vacía en medio de los datos.',
  ROW_WITHOUT_ASSET_ID: 'La fila no tiene identificador del activo.',
  ASSET_ID_DUPLICATED: 'El identificador del activo se repite en la hoja.',
  WRITE_OFF_DATE_MISSING: 'El activo está dado de baja pero no tiene fecha de baja.',
  WRITE_OFF_DATE_NOT_A_DATE: 'La fecha de baja no es válida.',
  WRITE_OFF_BEFORE_PURCHASE: 'La fecha de baja es anterior a la de compra.',
  WRITE_OFF_DATE_FUTURE: 'La fecha de baja es futura.',
  BARCODE_EMPTY: 'No tiene código de barras.',
  BARCODE_TEMP: 'El código de barras es TEMP. El activo nunca se identificó.',
  BARCODE_DUPLICATED: 'El código de barras se repite en varias filas.',
  PURCHASE_DATE_MISSING: 'No tiene fecha de compra.',
  PURCHASE_DATE_NOT_A_DATE: 'La fecha de compra no es válida.',
  PURCHASE_DATE_EPOCH: 'La fecha de compra es 1970-01-01. No es una fecha real.',
  PRICE_MISSING: 'No tiene precio de compra.',
  PRICE_NOT_A_NUMBER: 'El precio de compra no es un número.',
  PRICE_ZERO: 'El precio de compra es 0.',
  COST_CENTER_UNKNOWN: 'El centro de costo no existe.',
  COST_CENTER_WITHOUT_HEAD: 'El centro de costo no tiene jefe. Asígnele uno antes de importar sus activos.',
};

const SEPARATOR = ';';

const field = (value: string | number | null): string => csvCell(value, SEPARATOR);

export const issuesToCsv = (issues: ReadonlyArray<Issue>): string => {
  const header = ['Hoja', 'Fila', 'Columna', 'Problema', 'Valor encontrado', 'Detalle', 'Código'];
  const ordered = [...issues].sort(
    (left, right) =>
      left.sheet.localeCompare(right.sheet) || (left.rowNumber ?? 0) - (right.rowNumber ?? 0),
  );
  const lines = [
    header,
    ...ordered.map((issue) => [
      issue.sheet,
      issue.rowNumber,
      issue.column,
      ISSUE_DESCRIPTIONS[issue.code] ?? issue.code,
      issue.rawValue,
      issue.detail,
      issue.code,
    ]),
  ].map((values) => values.map(field).join(SEPARATOR));
  return `﻿${lines.join('\r\n')}\r\n`;
};

export const writeIssuesCsv = (path: string, issues: ReadonlyArray<Issue>): Promise<void> =>
  writeFile(path, issuesToCsv(issues), 'utf8');
