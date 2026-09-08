import { describe, expect, it } from 'vitest';
import { parseAssetCsv } from './parse-asset-csv.js';

describe('parseAssetCsv', () => {
  it('parsea filas y campos dinámicos extra', () => {
    const rows = parseAssetCsv(
      'description,category_code,cost_center_code,acquisition_type_code,acquisition_date,ramGB\nPortátil Dell,PORTATILES,4100,PURCHASE,2026-03-15,16\n',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.categoryCode).toBe('PORTATILES');
    expect(rows[0]?.customValues).toEqual({ ramGB: '16' });
  });

  it('retorna vacío si faltan columnas requeridas', () => {
    expect(parseAssetCsv('name,code\nfoo,bar\n')).toEqual([]);
  });
});
