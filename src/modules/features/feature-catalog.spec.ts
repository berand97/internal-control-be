import { describe, expect, it } from 'vitest';
import { featureCodesForPath, stripApiPrefix } from './feature-catalog.js';

describe('feature-catalog', () => {
  it('resuelve el módulo por prefijo de ruta', () => {
    expect(stripApiPrefix('/api/v1/loans')).toBe('/loans');
    expect(featureCodesForPath('/api/v1/loans')).toEqual(['loans']);
    expect(featureCodesForPath('/api/v1/loans/abc')).toEqual(['loans']);
    expect(featureCodesForPath('/api/v1/qr/verify')).toEqual(['qr-tokens']);
    expect(featureCodesForPath('/api/v1/assets/1/qr')).toEqual(['assets']);
    expect(featureCodesForPath('/api/v1/campus/1/buildings')).toEqual(['campus']);
  });
});
