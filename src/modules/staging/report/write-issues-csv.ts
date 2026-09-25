import { writeFile } from 'node:fs/promises';
import type { Issue } from '../diagnostics/asset-report-diagnostics.js';

export const ISSUE_DESCRIPTIONS: Record<string, string> = {
  MISSING_COLUMN: 'La columna esperada no aparece en el encabezado',
  EMPTY_ROW: 'Fila completamente vacía en medio de los datos',
  ROW_WITHOUT_ASSET_ID: 'Fila con datos pero sin identificador de activo',
  BARCODE_EMPTY: 'Código de barras vacío',
  BARCODE_TEMP: 'Código de barras TEMP: el activo nunca fue identificado',
  BARCODE_DUPLICATED: 'Código de barras repetido en varias filas',
  PURCHASE_DATE_MISSING: 'Sin fecha de compra',
  PURCHASE_DATE_NOT_A_DATE: 'La fecha de compra no es una fecha',
  PURCHASE_DATE_EPOCH: 'Fecha de compra 1970-01-01 (valor por defecto, no real)',
  PRICE_MISSING: 'Sin precio de compra',
  PRICE_NOT_A_NUMBER: 'El precio de compra no es un número',
  PRICE_ZERO: 'Precio de compra en 0',
  COST_CENTER_UNKNOWN: 'El centro de costo no existe en el catálogo',
};

const SEPARATOR = ';';

const field = (value: string | number | null): string => {
  const text = value === null ? '' : String(value);
  return /[";\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

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
