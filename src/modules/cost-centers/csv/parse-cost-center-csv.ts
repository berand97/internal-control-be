export interface CostCenterCsvRow {
  readonly externalCode: string;
  readonly name: string;
  readonly organizationalUnitCode: string | null;
  readonly acceptsAssets: boolean;
}

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

const parseBoolean = (value: string, fallback: boolean): boolean => {
  if (value === '') {
    return fallback;
  }
  const normalized = value.toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'si') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }
  return fallback;
};

export const parseCostCenterCsv = (content: string): CostCenterCsvRow[] => {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length < 2) {
    return [];
  }
  const header = (lines[0] ?? '').toLowerCase();
  if (
    !header.includes('external_code') ||
    !header.includes('name') ||
    !header.includes('organizational_unit_code')
  ) {
    return [];
  }
  const rows: CostCenterCsvRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const externalCode = cells[0] ?? '';
    const name = cells[1] ?? '';
    if (externalCode === '' || name === '') {
      continue;
    }
    const organizationalUnitCode = cells[2] && cells[2] !== '' ? cells[2] : null;
    rows.push({
      externalCode,
      name,
      organizationalUnitCode,
      acceptsAssets: parseBoolean(cells[3] ?? '', true),
    });
  }
  return rows;
};
