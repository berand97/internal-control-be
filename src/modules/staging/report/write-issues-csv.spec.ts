import { describe, expect, it } from 'vitest';
import { issuesToCsv } from './write-issues-csv.js';

describe('issuesToCsv (BE-10)', () => {
  it('el valor encontrado en el Excel no se abre como fórmula y el separador sigue siendo ;', () => {
    const csv = issuesToCsv([
      {
        sheet: 'Activos',
        rowNumber: 7,
        column: 'MovPrecio',
        code: 'PRICE_NOT_A_NUMBER',
        rawValue: '=cmd|"/c calc"!A1',
        detail: 'precio; con punto y coma',
      },
    ]);
    const line = csv.replace(/^﻿/, '').split('\r\n')[1];
    expect(line).toBe(
      `Activos;7;MovPrecio;El precio de compra no es un número;"'=cmd|""/c calc""!A1";"precio; con punto y coma";PRICE_NOT_A_NUMBER`,
    );
  });
});
