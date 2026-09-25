import ExcelJS from 'exceljs';
import type { AssetReportDiagnosis } from '../services/staging-diagnostics.service.js';

export const ISSUE_DESCRIPTIONS: Record<string, string> = {
  MISSING_COLUMN: 'La columna esperada no aparece en el encabezado',
  EMPTY_ROW: 'Fila completamente vacía en medio de los datos',
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

export const writeDiagnosticReport = async (
  path: string,
  diagnosis: AssetReportDiagnosis,
): Promise<void> => {
  const workbook = new ExcelJS.Workbook();

  const summary = workbook.addWorksheet('Resumen');
  summary.columns = [
    { header: 'Hoja', key: 'sheet', width: 26 },
    { header: 'Métrica', key: 'label', width: 48 },
    { header: 'Valor', key: 'value', width: 10 },
    { header: 'Sobre', key: 'base', width: 10 },
    { header: 'Detalle', key: 'detail', width: 70 },
  ];
  for (const sheet of diagnosis.sheets) {
    for (const metric of sheet.metrics) {
      summary.addRow({
        sheet: sheet.sheet,
        label: metric.label,
        value: metric.value ?? 'N/D',
        base: metric.base ?? '',
        detail: metric.detail ?? '',
      });
    }
  }
  for (const other of diagnosis.otherSheets) {
    summary.addRow({ sheet: other.name, label: 'Filas con datos', value: other.nonEmptyRows });
  }

  const problems = workbook.addWorksheet('Problemas por fila');
  problems.columns = [
    { header: 'Hoja', key: 'sheet', width: 26 },
    { header: 'Fila', key: 'rowNumber', width: 8 },
    { header: 'Columna', key: 'column', width: 20 },
    { header: 'Problema', key: 'description', width: 55 },
    { header: 'Valor encontrado', key: 'rawValue', width: 24 },
    { header: 'Detalle', key: 'detail', width: 50 },
    { header: 'Código', key: 'code', width: 26 },
  ];
  const ordered = [...diagnosis.issues].sort(
    (left, right) =>
      left.sheet.localeCompare(right.sheet) || (left.rowNumber ?? 0) - (right.rowNumber ?? 0),
  );
  for (const issue of ordered) {
    problems.addRow({
      ...issue,
      rowNumber: issue.rowNumber ?? '',
      description: ISSUE_DESCRIPTIONS[issue.code] ?? issue.code,
    });
  }
  for (const sheet of [summary, problems]) {
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
  }
  problems.autoFilter = { from: 'A1', to: 'G1' };

  await workbook.xlsx.writeFile(path);
};
