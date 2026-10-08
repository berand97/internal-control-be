import ExcelJS from 'exceljs';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import { assertZipWithinLimits, ZIP_LIMITS } from '../../../shared/storage/uploads/zip-limits.js';

export type RawCellValue = string | number | boolean;

export interface RawRow {
  readonly rowNumber: number;
  readonly cells: Record<string, RawCellValue>;
  readonly types: Record<string, string>;
}

export interface RawSheet {
  readonly name: string;
  readonly lastRow: number;
  readonly rows: ReadonlyArray<RawRow>;
}

const { ValueType } = ExcelJS;

/**
 * Topes de lectura (BE-05). La hoja más larga del informe real de activos (Movimientos, julio 2026) tiene 14.806
 * filas y el libro 5 hojas: 100.000 filas por hoja y 50 hojas dejan margen de años. Sin tope, una sola celda en la
 * fila 1.048.576 hacía crear un objeto por cada fila vacía intermedia.
 */
export const MAX_SHEET_ROWS = 100_000;
export const MAX_SHEETS = 50;

const isErrorValue = (value: unknown): value is { error: string } =>
  typeof value === 'object' && value !== null && 'error' in value;

const fromPrimitive = (value: unknown): [RawCellValue, string] | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return [value.toISOString(), 'date'];
  }
  if (typeof value === 'number') {
    return [value, 'number'];
  }
  if (typeof value === 'boolean') {
    return [value, 'boolean'];
  }
  if (typeof value === 'string') {
    return [value, 'string'];
  }
  if (isErrorValue(value)) {
    return [value.error, 'error'];
  }
  return null;
};

const readCell = (cell: ExcelJS.Cell): [RawCellValue, string] | null => {
  switch (cell.type) {
    case ValueType.Null:
    case ValueType.Merge:
      return null;
    case ValueType.RichText:
      return [cell.text, 'richText'];
    case ValueType.Hyperlink:
      return [cell.text, 'hyperlink'];
    case ValueType.Formula: {
      const result = fromPrimitive(cell.result);
      return result ? [result[0], `formula:${result[1]}`] : null;
    }
    case ValueType.Error:
      return isErrorValue(cell.value) ? [cell.value.error, 'error'] : null;
    default:
      return fromPrimitive(cell.value);
  }
};

const columnLetter = (address: string): string => address.replace(/\d+/g, '');

export const readWorkbook = async (content: Buffer): Promise<ReadonlyArray<RawSheet>> =>
  (await readWorkbookWithProperties(content)).sheets;

export interface RawWorkbook {
  readonly sheets: ReadonlyArray<RawSheet>;
  /** Fecha de creación del libro (propiedades del documento); null si no la trae. */
  readonly createdAt: Date | null;
}

/** Como readWorkbook, más la fecha de creación del libro (Excel la conserva al guardar). */
export const readWorkbookWithProperties = async (content: Buffer): Promise<RawWorkbook> => {
  assertZipWithinLimits(content, ZIP_LIMITS.XLSX);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(content as unknown as ArrayBuffer);
  if (workbook.worksheets.length > MAX_SHEETS) {
    throw new ApiException(
      ErrorCode.ArchiveTooLarge,
      `El libro tiene ${workbook.worksheets.length} hojas; el máximo es ${MAX_SHEETS}`,
    );
  }
  const tooLong = workbook.worksheets.find((worksheet) => worksheet.rowCount > MAX_SHEET_ROWS);
  if (tooLong) {
    throw new ApiException(
      ErrorCode.ArchiveTooLarge,
      `La hoja "${tooLong.name}" llega hasta la fila ${tooLong.rowCount}; el máximo es ${MAX_SHEET_ROWS}. Borre las filas vacías sobrantes al final de la hoja`,
    );
  }
  const created = workbook.created as Date | undefined;
  const createdAt = created instanceof Date && !Number.isNaN(created.getTime()) ? created : null;
  const sheets = workbook.worksheets.map((worksheet) => {
    const rows: RawRow[] = [];
    for (let rowNumber = 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
      const cells: Record<string, RawCellValue> = {};
      const types: Record<string, string> = {};
      worksheet.getRow(rowNumber).eachCell({ includeEmpty: false }, (cell) => {
        const read = readCell(cell);
        if (read) {
          const letter = columnLetter(cell.address);
          cells[letter] = read[0];
          types[letter] = read[1];
        }
      });
      rows.push({ rowNumber, cells, types });
    }
    return { name: worksheet.name, lastRow: worksheet.rowCount, rows };
  });
  return { sheets, createdAt };
};
