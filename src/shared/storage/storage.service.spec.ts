import path from 'node:path';
import type { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../../common/constants/error-code.enum.js';
import type { AppConfig } from '../../config/configuration.js';
import { SecretCipherService } from '../crypto/secret-cipher.service.js';
import type { StorageSettings } from './entities/storage-settings.entity.js';
import { StorageService } from './storage.service.js';

const DEPLOYED = path.resolve('/data/storage');

const cipherWith = (current: string, previous: string[] = []) =>
  new SecretCipherService({
    getOrThrow: (key: string) => (key === 'settingsEncryptionKey' ? current : previous),
  } as unknown as ConfigService<AppConfig, true>);

const build = (
  row: Partial<StorageSettings> | null,
  options: { cipher?: SecretCipherService; allowPrivateNetworks?: boolean } = {},
) => {
  const save = vi.fn(async (value: StorageSettings) => value);
  const settings = {
    find: vi.fn(async () => (row ? [row] : [])),
    save,
    create: vi.fn((value: Partial<StorageSettings>) => value),
  } as unknown as Repository<StorageSettings>;
  const values: Record<string, unknown> = {
    storage: {
      driver: 'project',
      projectPath: DEPLOYED,
      s3: { provider: 'minio', endpoint: null, region: 'us-east-1', bucket: null, accessKey: null, secretKey: null, forcePathStyle: true },
      google: { clientId: null, clientSecret: null, refreshToken: null, folderId: null },
      onedrive: { tenantId: null, clientId: null, clientSecret: null, refreshToken: null, folderId: null },
    },
    apiPublicUrl: 'http://api',
    outbound: { allowPrivateNetworks: options.allowPrivateNetworks ?? true, allowedHosts: ['minio.interno.example'] },
  };
  const config = {
    getOrThrow: (key: string) => values[key],
  } as unknown as ConfigService<AppConfig, true>;
  const cipher = options.cipher ?? cipherWith('clave-unitaria');
  return { service: new StorageService(settings, config, cipher), save, cipher };
};

describe('StorageService: carpeta del driver project (BE-01)', () => {
  it('PATCH con projectPath "/" responde 400 STORAGE_PROJECT_PATH_LOCKED y no guarda', async () => {
    const { service, save } = build({ driver: 'project', projectPath: DEPLOYED });
    await expect(service.updateSettings({ projectPath: '/' }, 'actor')).rejects.toMatchObject({
      code: ErrorCode.StorageProjectPathLocked,
    });
    expect(save).not.toHaveBeenCalled();
  });

  it('acepta reenviar el mismo valor que devuelve el estado (el formulario lo hace)', async () => {
    const { service, save } = build({ driver: 'project', projectPath: DEPLOYED });
    const status = await service.status();
    await service.updateSettings({ projectPath: status.projectPath, driver: 'project' }, 'actor');
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toMatchObject({ projectPath: DEPLOYED });
  });

  it('ignora una project_path distinta guardada en la BD: el estado muestra la del despliegue', async () => {
    const { service } = build({ driver: 'project', projectPath: '/' });
    const status = await service.status();
    expect(status.projectPath).toBe(DEPLOYED);
  });

  it('GET /storage/objects?key=/proc/self/environ no llega al disco aunque la fila tenga "/"', async () => {
    const { service } = build({ driver: 'project', projectPath: '/' });
    await expect(service.get('proc/self/environ')).rejects.toMatchObject({ code: ErrorCode.ResourceNotFound });
    await expect(service.get('/proc/self/environ')).rejects.toMatchObject({ code: ErrorCode.StorageKeyInvalid });
    await expect(service.getFrom('s3', '../x')).rejects.toMatchObject({ code: ErrorCode.StorageKeyInvalid });
    await expect(service.exists('a/../../x')).rejects.toMatchObject({ code: ErrorCode.StorageKeyInvalid });
    await expect(service.delete('/etc/hostname')).rejects.toMatchObject({ code: ErrorCode.StorageKeyInvalid });
    await expect(service.presignGet('a\u0000b')).rejects.toMatchObject({ code: ErrorCode.StorageKeyInvalid });
  });
});

describe('StorageService: credenciales cifradas en reposo (BE-11)', () => {
  it('PATCH con secretos los guarda cifrados (enc.v1.) y el estado sigue funcionando', async () => {
    const { service, save, cipher } = build({ driver: 'project', projectPath: DEPLOYED });
    await service.updateSettings(
      {
        s3SecretKey: 's3-secreto-plano',
        googleClientId: 'cliente.apps.googleusercontent.com',
        googleClientSecret: 'GOCSPX-secreto',
        onedriveClientSecret: 'onedrive-secreto',
      },
      'actor',
    );
    const saved = save.mock.calls[0]?.[0] as StorageSettings;
    for (const value of [saved.s3SecretKey, saved.googleClientSecret, saved.onedriveClientSecret]) {
      expect(value).toMatch(/^enc\.v1\./);
    }
    expect(JSON.stringify(saved)).not.toContain('secreto');
    expect(cipher.decrypt(saved.googleClientSecret)).toBe('GOCSPX-secreto');
    const status = await service.status();
    expect(status.googleClientId).toBe('cl****om');
  });

  it('una fila legada en claro se sella la primera vez que se lee', async () => {
    const row = { driver: 'google_drive', projectPath: DEPLOYED, googleClientId: 'id', googleClientSecret: 'plano', googleRefreshToken: '1//refresh' } as Partial<StorageSettings>;
    const { service, save } = build(row);
    const status = await service.status();
    expect(status.googleConnected).toBe(true);
    const saved = save.mock.calls[0]?.[0] as StorageSettings;
    expect(saved.googleRefreshToken).toMatch(/^enc\.v1\./);
    expect(saved.googleClientSecret).toMatch(/^enc\.v1\./);
  });

  it('rotación: con la clave anterior en SETTINGS_ENCRYPTION_KEY_PREVIOUS lee y vuelve a sellar con la actual', async () => {
    const old = cipherWith('clave-vieja');
    const row = { driver: 'google_drive', projectPath: DEPLOYED, googleClientId: 'id', googleClientSecret: old.encrypt('plano'), googleRefreshToken: old.encrypt('1//refresh') } as Partial<StorageSettings>;
    const rotated = cipherWith('clave-nueva', ['clave-vieja']);
    const { service, save } = build(row, { cipher: rotated });
    expect((await service.status()).googleConnected).toBe(true);
    const saved = save.mock.calls[0]?.[0] as StorageSettings;
    expect(cipherWith('clave-nueva').decrypt(saved.googleRefreshToken)).toBe('1//refresh');
  });
});

describe('StorageService: endpoint S3 fuera de la red interna (BE-16)', () => {
  it.each(['http://10.0.0.5:9000', 'http://127.0.0.1:9000', 'https://169.254.169.254', 'http://localhost:9000', 'https://gotenberg:3000', 'http://[::1]:9000'])(
    'en producción rechaza %s con OUTBOUND_DESTINATION_FORBIDDEN',
    async (endpoint) => {
      const { service, save } = build({ driver: 'project', projectPath: DEPLOYED }, { allowPrivateNetworks: false });
      await expect(service.updateSettings({ s3Endpoint: endpoint }, 'actor')).rejects.toMatchObject({
        code: expect.stringMatching(/^(OUTBOUND_DESTINATION_FORBIDDEN|VALIDATION_FAILED)$/),
      });
      expect(save).not.toHaveBeenCalled();
    },
  );

  it('rechaza URL con usuario, parámetros o esquema distinto de http(s)', async () => {
    const { service } = build({ driver: 'project', projectPath: DEPLOYED });
    for (const endpoint of ['ftp://s3.example.com', 'https://user:pw@s3.example.com', 'https://s3.example.com/?x=1', 'no es url']) {
      await expect(service.updateSettings({ s3Endpoint: endpoint }, 'actor')).rejects.toMatchObject({
        code: ErrorCode.ValidationFailed,
      });
    }
  });

  it('un host de OUTBOUND_ALLOWED_HOSTS pasa aunque sea http en producción', async () => {
    const { service, save } = build({ driver: 'project', projectPath: DEPLOYED }, { allowPrivateNetworks: false });
    await service.updateSettings({ s3Endpoint: 'http://minio.interno.example:9000' }, 'actor');
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('en desarrollo (redes privadas permitidas) MinIO en localhost funciona', async () => {
    const { service, save } = build({ driver: 'project', projectPath: DEPLOYED });
    await service.updateSettings({ s3Endpoint: 'http://localhost:9000' }, 'actor');
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe('StorageService.testConnection con S3 (sin red)', () => {
  const s3Row = (extra: Partial<StorageSettings> = {}): Partial<StorageSettings> => ({
    driver: 's3',
    projectPath: DEPLOYED,
    s3Provider: 'minio',
    s3Region: 'us-east-1',
    s3Bucket: 'control-interno',
    s3AccessKey: 'svc-control-interno',
    s3SecretKey: 'secreto-de-prueba',
    s3ForcePathStyle: true,
    ...extra,
  });

  it('sin bucket ni claves: 200 con CONFIGURATION FAILED STORAGE_NOT_CONFIGURED (no lanza)', async () => {
    const { service } = build(s3Row({ s3Bucket: null, s3AccessKey: null, s3SecretKey: null }));
    const result = await service.testConnection();
    expect(result).toMatchObject({ ok: false, driver: 's3', bucket: null });
    expect(result.checks[0]).toMatchObject({ name: 'CONFIGURATION', status: 'FAILED', errorCode: 'STORAGE_NOT_CONFIGURED' });
    expect(result.checks.slice(1).every((check) => check.status === 'SKIPPED')).toBe(true);
  });

  it('producción sin OUTBOUND_ALLOWED_HOSTS: http://minio:9000 y una IP privada se rechazan sin conectar', async () => {
    for (const endpoint of ['http://minio:9000', 'https://10.0.0.5:9000', 'https://minio.local']) {
      const { service } = build(s3Row({ s3Endpoint: endpoint }), { allowPrivateNetworks: false });
      const result = await service.testConnection();
      expect(result.ok).toBe(false);
      expect(result.checks[1]).toMatchObject({
        name: 'DESTINATION',
        status: 'FAILED',
        errorCode: 'OUTBOUND_DESTINATION_FORBIDDEN',
      });
      expect(result.checks.find((check) => check.name === 'ENDPOINT')?.status).toBe('SKIPPED');
      expect(JSON.stringify(result)).not.toContain('secreto-de-prueba');
    }
  });

  it('producción: http a un host público no autorizado es ENDPOINT_NOT_ALLOWED', async () => {
    const { service } = build(s3Row({ s3Endpoint: 'http://s3.example.com' }), { allowPrivateNetworks: false });
    const result = await service.testConnection();
    expect(result.checks[1]).toMatchObject({ name: 'DESTINATION', errorCode: 'ENDPOINT_NOT_ALLOWED' });
  });

  it('host autorizado en OUTBOUND_ALLOWED_HOSTS pasa DESTINATION (y la prueba sigue hasta el endpoint)', async () => {
    // minio.interno.example no resuelve: pasa la guarda y falla al conectar, sin reintentos.
    const { service } = build(s3Row({ s3Endpoint: 'http://minio.interno.example:9000' }), { allowPrivateNetworks: false });
    const result = await service.testConnection();
    expect(result.checks[1]).toMatchObject({ name: 'DESTINATION', status: 'PASSED' });
    expect(result.checks[2]).toMatchObject({ name: 'ENDPOINT', status: 'FAILED' });
    expect(['ENDPOINT_UNREACHABLE', 'ENDPOINT_TIMEOUT']).toContain(result.checks[2]?.errorCode);
  }, 30_000);
});
