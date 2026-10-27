import { describe, expect, it } from 'vitest';
import { readSkipMfaAtLogin } from './skip-mfa-at-login.js';

describe('readSkipMfaAtLogin', () => {
  it('queda apagado si la variable no está', () => {
    expect(readSkipMfaAtLogin({ NODE_ENV: 'development' })).toBe(false);
    expect(readSkipMfaAtLogin({ NODE_ENV: 'production' })).toBe(false);
  });

  it('queda apagado con false o 0 en cualquier entorno', () => {
    expect(readSkipMfaAtLogin({ NODE_ENV: 'production', AUTH_SKIP_MFA: 'false' })).toBe(false);
    expect(readSkipMfaAtLogin({ NODE_ENV: 'production', AUTH_SKIP_MFA: '0' })).toBe(false);
  });

  it('se activa solo con NODE_ENV=development', () => {
    expect(readSkipMfaAtLogin({ NODE_ENV: 'development', AUTH_SKIP_MFA: 'true' })).toBe(true);
    expect(readSkipMfaAtLogin({ NODE_ENV: 'development', AUTH_SKIP_MFA: '1' })).toBe(true);
  });

  it.each(['production', 'test', 'staging', 'Development', undefined])(
    'impide arrancar si se activa con NODE_ENV=%s',
    (nodeEnv) => {
      expect(() =>
        readSkipMfaAtLogin({ NODE_ENV: nodeEnv, AUTH_SKIP_MFA: 'true' }),
      ).toThrow(/solo se permite con NODE_ENV=development/);
    },
  );

  it('rechaza valores que no son booleanos', () => {
    expect(() =>
      readSkipMfaAtLogin({ NODE_ENV: 'development', AUTH_SKIP_MFA: 'yes' }),
    ).toThrow(/AUTH_SKIP_MFA inválido/);
  });
});
