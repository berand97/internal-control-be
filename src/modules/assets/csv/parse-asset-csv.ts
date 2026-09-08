export interface AssetCsvRow {
  readonly rowNumber: number;
  readonly internalCode: string | null;
  readonly description: string;
  readonly categoryCode: string;
  readonly costCenterCode: string;
  readonly locationCode: string | null;
  readonly acquisitionTypeCode: string;
  readonly acquisitionDate: string;
  readonly acquisitionPrice: string | null;
  readonly serialNumber: string | null;
  readonly barcode: string | null;
  readonly model: string | null;
  readonly photoUrl: string | null;
  readonly notes: string | null;
  readonly customValues: Record<string, string>;
}

const KNOWN = new Set([
  'internal_code',
  'description',
  'category_code',
  'cost_center_code',
  'location_code',
  'acquisition_type_code',
  'acquisition_date',
  'acquisition_price',
  'serial_number',
  'barcode',
  'model',
  'photo_url',
  'notes',
]);

const splitCsvLine = (line: string): string[] => {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === ',' && !inQuotes) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
};

const cell = (cells: ReadonlyArray<string>, index: number): string | null => {
  const value = cells[index] ?? '';
  return value === '' ? null : value;
};

export const parseAssetCsv = (content: string): AssetCsvRow[] => {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length < 2) {
    return [];
  }
  const rawHeaders = splitCsvLine(lines[0] ?? '');
  const headers = rawHeaders.map((header) => header.toLowerCase());
  const required = [
    'description',
    'category_code',
    'cost_center_code',
    'acquisition_type_code',
    'acquisition_date',
  ];
  if (required.some((name) => !headers.includes(name))) {
    return [];
  }
  const indexOf = (name: string): number => headers.indexOf(name);
  const rows: AssetCsvRow[] = [];
  for (const [offset, line] of lines.slice(1).entries()) {
    const cells = splitCsvLine(line);
    const description = cell(cells, indexOf('description'));
    const categoryCode = cell(cells, indexOf('category_code'));
    const costCenterCode = cell(cells, indexOf('cost_center_code'));
    const acquisitionTypeCode = cell(cells, indexOf('acquisition_type_code'));
    const acquisitionDate = cell(cells, indexOf('acquisition_date'));
    if (
      !description ||
      !categoryCode ||
      !costCenterCode ||
      !acquisitionTypeCode ||
      !acquisitionDate
    ) {
      continue;
    }
    const customValues: Record<string, string> = {};
    headers.forEach((header, index) => {
      if (KNOWN.has(header)) {
        return;
      }
      const original = rawHeaders[index] ?? header;
      const value = cell(cells, index);
      if (value !== null) {
        customValues[original] = value;
      }
    });
    rows.push({
      rowNumber: offset + 2,
      internalCode: cell(cells, indexOf('internal_code')),
      description,
      categoryCode,
      costCenterCode,
      locationCode: cell(cells, indexOf('location_code')),
      acquisitionTypeCode,
      acquisitionDate,
      acquisitionPrice: cell(cells, indexOf('acquisition_price')),
      serialNumber: cell(cells, indexOf('serial_number')),
      barcode: cell(cells, indexOf('barcode')),
      model: cell(cells, indexOf('model')),
      photoUrl: cell(cells, indexOf('photo_url')),
      notes: cell(cells, indexOf('notes')),
      customValues,
    });
  }
  return rows;
};
