const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

export const neutralizeCsvFormula = (value: string): string =>
  FORMULA_TRIGGER.test(value) ? `'${value}` : value;

export const csvCell = (
  value: string | number | null | undefined,
  separator: ',' | ';' = ',',
): string => {
  if (value === null || value === undefined || value === '') {
    return '';
  }
  const text = typeof value === 'number' ? String(value) : neutralizeCsvFormula(value);
  if (text.includes(separator) || text.includes('"') || text.includes('\n') || text.includes('\r')) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
};
