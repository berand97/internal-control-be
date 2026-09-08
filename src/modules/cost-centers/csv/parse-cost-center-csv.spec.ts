import { describe, expect, it } from 'vitest';
import { parseCostCenterCsv } from './parse-cost-center-csv.js';

describe('parseCostCenterCsv', () => {
  it('parsea filas válidas e ignora vacías', () => {
    const rows = parseCostCenterCsv(
      '\uFEFFexternal_code,name,organizational_unit_code,accepts_assets\n4330,Talento Humano,DTH,true\n,faltante,,\n1100,Rectoría,,false\n',
    );
    expect(rows).toEqual([
      {
        externalCode: '4330',
        name: 'Talento Humano',
        organizationalUnitCode: 'DTH',
        acceptsAssets: true,
      },
      {
        externalCode: '1100',
        name: 'Rectoría',
        organizationalUnitCode: null,
        acceptsAssets: false,
      },
    ]);
  });

  it('retorna vacío si falta el encabezado', () => {
    expect(parseCostCenterCsv('a,b,c\n1,2,3')).toEqual([]);
  });
});
