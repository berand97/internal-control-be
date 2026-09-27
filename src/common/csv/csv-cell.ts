/**
 * Celdas de CSV seguras para abrir en Excel o LibreOffice (BE-10, CWE-1236).
 *
 * Una celda que empieza por `=`, `+`, `-`, `@`, tabulador o retorno de carro se interpreta como fórmula aunque vaya
 * entre comillas. Se le antepone una comilla simple (`'`), la neutralización que recomienda OWASP: la hoja muestra el
 * texto y no lo evalúa. El valor sigue siendo legible (solo cambia por el `'` inicial) y, al importar el CSV en otra
 * herramienta, basta quitar ese primer carácter en las celdas que lo traigan.
 *
 * Después se aplica el entrecomillado RFC 4180 si el valor contiene el separador, comillas o saltos de línea.
 */
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
  // Los números que genera el propio sistema (fila, conteos) no son texto de usuario: van tal cual.
  const text = typeof value === 'number' ? String(value) : neutralizeCsvFormula(value);
  if (text.includes(separator) || text.includes('"') || text.includes('\n') || text.includes('\r')) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
};
