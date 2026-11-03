import { describe, expect, it } from 'vitest';
import { ErrorCode } from '../../common/constants/error-code.enum.js';
import {
  assetPhotoKey,
  assetPhotoStagedKey,
  assetPhotoThumbKey,
  isPublicKey,
  storageDate,
} from './storage-keys.js';

const JUNE = new Date('2026-06-15T15:00:00Z');
const invalid = { code: ErrorCode.StorageKeyInvalid };
const base = { uploadedAt: JUNE, costCenterCode: '4310', assetCode: 'UNAC-000123', seq: 1 };

describe('llaves de fotos de activos', () => {
  it('foto, miniatura y pendiente', () => {
    expect(assetPhotoKey({ ...base, ext: 'jpg' })).toBe('assets/2026/4310/UNAC-000123_2026-06-15_1.jpg');
    expect(assetPhotoKey({ ...base, seq: 3, ext: 'webp' })).toBe('assets/2026/4310/UNAC-000123_2026-06-15_3.webp');
    expect(assetPhotoThumbKey(base)).toBe('assets/miniaturas/2026/4310/UNAC-000123_2026-06-15_1.webp');
    expect(assetPhotoStagedKey('3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b')).toBe(
      'assets/_pendientes/3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b',
    );
  });

  it('nunca quedan bajo el prefijo público', () => {
    expect(isPublicKey(assetPhotoKey({ ...base, costCenterCode: 'images', ext: 'png' }))).toBe(false);
    expect(isPublicKey(assetPhotoThumbKey(base))).toBe(false);
  });

  it('año y fecha en Bogotá: el 1 de enero 03:00 UTC sigue en el 31 de diciembre', () => {
    const lateNight = { ...base, uploadedAt: new Date('2027-01-01T03:00:00Z'), ext: 'jpg' as const };
    expect(assetPhotoKey(lateNight)).toBe('assets/2026/4310/UNAC-000123_2026-12-31_1.jpg');
    expect(storageDate(new Date('2027-01-01T05:00:00Z'))).toBe('2027-01-01');
  });

  it.each([
    ['../../etc', 'UNAC-1'],
    ['a/b', 'UNAC-1'],
    ['4310', '../secreto'],
    ['4310', 'x/../../y'],
    ['..', '..'],
  ])('centro %j y activo %j no salen de assets/<año>/<centro>/', (costCenterCode, assetCode) => {
    const key = assetPhotoKey({ ...base, costCenterCode, assetCode, ext: 'jpg' });
    expect(key.startsWith('assets/2026/')).toBe(true);
    expect(key.split('/')).toHaveLength(4);
    expect(key).not.toContain('..');
  });

  it.each([0, -1, 1.5, Number.NaN])('secuencia %s: STORAGE_KEY_INVALID', (seq) => {
    expect(() => assetPhotoKey({ ...base, seq, ext: 'jpg' })).toThrow(expect.objectContaining(invalid));
  });

  it('extensión fuera de jpg, png o webp: STORAGE_KEY_INVALID', () => {
    expect(() => assetPhotoKey({ ...base, ext: 'svg' as 'jpg' })).toThrow(expect.objectContaining(invalid));
  });

  it('la llave pendiente solo acepta un UUID', () => {
    expect(() => assetPhotoStagedKey('../x')).toThrow(expect.objectContaining(invalid));
  });

  it('fecha inválida: STORAGE_KEY_INVALID', () => {
    expect(() => assetPhotoKey({ ...base, uploadedAt: new Date('x'), ext: 'jpg' })).toThrow(
      expect.objectContaining(invalid),
    );
  });
});
