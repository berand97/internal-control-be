import { describe, expect, it } from 'vitest';
import { validateEnv } from './validation.schema.js';

const required = {
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/app',
  JWT_ACCESS_SECRET: 'access',
  JWT_REFRESH_SECRET: 'refresh',
};

describe('validateEnv', () => {
  it('impide arrancar en producción con AUTH_SKIP_MFA=true', () => {
    expect(() =>
      validateEnv({ ...required, NODE_ENV: 'production', AUTH_SKIP_MFA: 'true' }),
    ).toThrow(/AUTH_SKIP_MFA solo se permite con NODE_ENV=development/);
  });

  it('arranca en desarrollo con AUTH_SKIP_MFA=true', () => {
    expect(() =>
      validateEnv({ ...required, NODE_ENV: 'development', AUTH_SKIP_MFA: 'true' }),
    ).not.toThrow();
  });

  it('arranca en producción sin AUTH_SKIP_MFA', () => {
    expect(() => validateEnv({ ...required, NODE_ENV: 'production' })).not.toThrow();
  });
});
