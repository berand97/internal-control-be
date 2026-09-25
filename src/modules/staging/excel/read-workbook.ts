import ExcelJS from 'exceljs';

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

export const readWorkbook = async (content: Buffer): Promise<ReadonlyArray<RawSheet>> => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(content as unknown as ArrayBuffer);
  return workbook.worksheets.map((worksheet) => {
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
};
