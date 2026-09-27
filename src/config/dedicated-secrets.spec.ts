import { afterEach, describe, expect, it } from 'vitest';
import configuration from './configuration.js';
import { dedicatedSecretWarnings, resolveDedicatedSecrets } from './dedicated-secrets.js';

const base = {
  NODE_ENV: 'production',
  JWT_ACCESS_SECRET: 'jwt-access',
  JWT_REFRESH_SECRET: 'jwt-refresh',
  QR_SIGNING_SECRET: 'qr-propia',
  MOVEMENT_SIGNING_SECRET: 'movimientos-propia',
  SETTINGS_ENCRYPTION_KEY: 'ajustes-propia',
};

describe('claves separadas por propósito (BE-12)', () => {
  it.each(['QR_SIGNING_SECRET', 'MOVEMENT_SIGNING_SECRET', 'SETTINGS_ENCRYPTION_KEY'])(
    'en producción sin %s no arranca',
    (name) => {
      expect(() => resolveDedicatedSecrets({ ...base, [name]: '' })).toThrow(
        new RegExp(`${name} es obligatoria en producción`),
      );
    },
  );

  it.each([
    ['QR_SIGNING_SECRET', 'jwt-access', 'JWT_ACCESS_SECRET'],
    ['MOVEMENT_SIGNING_SECRET', 'jwt-access', 'JWT_ACCESS_SECRET'],
    ['SETTINGS_ENCRYPTION_KEY', 'jwt-refresh', 'JWT_REFRESH_SECRET'],
  ])('en producción %s igual a un secreto JWT no arranca', (name, value, clash) => {
    expect(() => resolveDedicatedSecrets({ ...base, [name]: value })).toThrow(
      `${name} no puede ser igual a ${clash}`,
    );
  });

  it('en producción rechaza el texto de ejemplo de .env.example', () => {
    expect(() =>
      resolveDedicatedSecrets({ ...base, SETTINGS_ENCRYPTION_KEY: 'reemplazar-por-openssl-rand-base64-32' }),
    ).toThrow(/valor de ejemplo/);
  });

  it('una clave anterior no puede ser el secreto JWT vigente (hay que rotarlo primero)', () => {
    expect(() =>
      resolveDedicatedSecrets({ ...base, MOVEMENT_SIGNING_SECRET_PREVIOUS: 'viejo,jwt-access' }),
    ).toThrow(/MOVEMENT_SIGNING_SECRET_PREVIOUS contiene el valor actual de JWT_ACCESS_SECRET/);
  });

  it('despliegue sin romper nada: las tres con el valor heredado (antiguo JWT) y el JWT ya rotado arranca, con aviso', () => {
    const legacy = 'valor-heredado-del-jwt';
    const env = {
      ...base,
      JWT_ACCESS_SECRET: 'jwt-nuevo',
      QR_SIGNING_SECRET: legacy,
      MOVEMENT_SIGNING_SECRET: legacy,
      SETTINGS_ENCRYPTION_KEY: legacy,
    };
    const secrets = resolveDedicatedSecrets(env);
    expect(secrets.movementSigningSecret).toBe(legacy);
    expect(secrets.settingsEncryptionKey).toBe(legacy);
    expect(dedicatedSecretWarnings(env)).toHaveLength(3);
  });

  it('lee las claves anteriores separadas por comas', () => {
    const secrets = resolveDedicatedSecrets({
      ...base,
      MOVEMENT_SIGNING_SECRET_PREVIOUS: ' a , b ',
      SETTINGS_ENCRYPTION_KEY_PREVIOUS: 'c',
    });
    expect(secrets.movementSigningPreviousSecrets).toEqual(['a', 'b']);
    expect(secrets.settingsEncryptionPreviousKeys).toEqual(['c']);
  });

  it('fuera de producción conserva el valor por defecto (JWT_ACCESS_SECRET) para no romper entornos locales', () => {
    const secrets = resolveDedicatedSecrets({ NODE_ENV: 'development', JWT_ACCESS_SECRET: 'dev' });
    expect(secrets).toMatchObject({ qrSecret: 'dev', movementSigningSecret: 'dev', settingsEncryptionKey: 'dev' });
    expect(dedicatedSecretWarnings({ NODE_ENV: 'development' })).toEqual([]);
  });
});

describe('configuration() en producción y claves propias', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  const deployed = {
    DATABASE_URL: 'postgres://u:p@control-interno-database:5432/db',
    SIGNATURE_VERIFY_URL: 'https://control-interno.unac.edu.co/verificar-firma',
    GOTENBERG_URL: 'http://gotenberg:3000',
  };

  it('sin SETTINGS_ENCRYPTION_KEY no arranca, con un mensaje que dice qué valor fijar', () => {
    process.env = { ...base, ...deployed, SETTINGS_ENCRYPTION_KEY: '' };
    expect(() => configuration()).toThrow(
      /SETTINGS_ENCRYPTION_KEY es obligatoria en producción.*JWT_ACCESS_SECRET/,
    );
  });

  it('con claves propias arranca y las expone por separado; destinos privados cerrados por defecto', () => {
    process.env = { ...base, ...deployed, OUTBOUND_ALLOWED_HOSTS: 'minio, relay.interno' };
    const config = configuration();
    expect(config.jwt.qrSecret).toBe('qr-propia');
    expect(config.movementSigningSecret).toBe('movimientos-propia');
    expect(config.settingsEncryptionKey).toBe('ajustes-propia');
    expect(config.outbound).toEqual({ allowPrivateNetworks: false, allowedHosts: ['minio', 'relay.interno'] });
  });
});
