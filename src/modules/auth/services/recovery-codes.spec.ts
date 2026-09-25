import { describe, expect, it } from 'vitest';
import {
  generateRecoveryCode,
  generateRecoveryCodes,
  normalizeRecoveryCode,
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_ENTROPY_BITS,
} from './recovery-codes.js';

describe('códigos de recuperación', () => {
  it('genera 10 códigos distintos con formato XXXX-XXXX-XXXX y 60 bits', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
    for (const code of codes) {
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    }
    expect(RECOVERY_CODE_ENTROPY_BITS).toBe(60);
  });

  it('normaliza minúsculas, espacios, guiones y confusiones O/I/L', () => {
    const code = generateRecoveryCode();
    const canonical = code.replace(/-/g, '');
    expect(normalizeRecoveryCode(code)).toBe(canonical);
    expect(normalizeRecoveryCode(` ${code.toLowerCase().replace(/-/g, ' ')} `)).toBe(canonical);
    expect(normalizeRecoveryCode('0O1I-L000-1111')).toBe('001110001111');
  });

  it('rechaza lo que no puede ser un código', () => {
    expect(normalizeRecoveryCode('123456')).toBeNull();
    expect(normalizeRecoveryCode('AAAA-BBBB-CCCU')).toBeNull();
    expect(normalizeRecoveryCode('AAAA-BBBB-CCCC-D')).toBeNull();
  });
});
