import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../../common/constants/error-code.enum.js';
import type { AppConfig } from '../../config/configuration.js';
import { SecretCipherService } from '../crypto/secret-cipher.service.js';
import type { StorageSettings } from './entities/storage-settings.entity.js';
import {
  PublicAssetsConfigError,
  normalizePublicAssetsBaseUrl,
  normalizePublicAssetsBucket,
  publicAssetUrl,
} from './public-assets.js';
import { StorageService } from './storage.service.js';

const cipher = new SecretCipherService({
  getOrThrow: (key: string) => (key === 'settingsEncryptionKey' ? 'clave-unitaria' : []),
} as unknown as ConfigService<AppConfig, true>);

const S3_ROW: Partial<StorageSettings> = {
  driver: 's3',
  s3Provider: 'minio',
  s3Endpoint: 'https://minio-api.unac.edu.co',
  s3Region: 'us-east-1',
  s3Bucket: 'control-interno',
  s3AccessKey: 'svc-control-interno',
  s3SecretKey: 'secreto',
  s3ForcePathStyle: true,
  s3PublicAssetsBucket: 'control-interno-public',
  s3PublicAssetsBaseUrl: 'https://minio-api.unac.edu.co/control-interno-public',
};

const build = (row: Partial<StorageSettings>) => {
  const save = vi.fn(async (value: StorageSettings) => value);
  const settings = {
    find: vi.fn(async () => [row]),
    save,
    create: vi.fn((value: Partial<StorageSettings>) => ({ ...value })),
  } as unknown as Repository<StorageSettings>;
  const values: Record<string, unknown> = {
    storage: {
      driver: 'project',
      projectPath: '/data/storage',
      s3: {
        provider: 'minio',
        endpoint: null,
        region: 'us-east-1',
        bucket: null,
        accessKey: null,
        secretKey: null,
        forcePathStyle: true,
        publicAssetsBucket: null,
        publicAssetsBaseUrl: null,
      },
      google: { clientId: null, clientSecret: null, refreshToken: null, folderId: null },
      onedrive: { tenantId: null, clientId: null, clientSecret: null, refreshToken: null, folderId: null },
    },
    apiPublicUrl: 'http://api',
    outbound: { allowPrivateNetworks: false, allowedHosts: [] },
  };
  const config = { getOrThrow: (key: string) => values[key] } as unknown as ConfigService<AppConfig, true>;
  return { service: new StorageService(settings, config, cipher), save };
};

const INPUT = {
  key: 'images/email/3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b.png',
  body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  contentType: 'image/png',
  cacheControl: 'public, max-age=31536000, immutable',
};

describe('bucket público de imágenes: validación', () => {
  it('URL base: https en producción, http solo fuera; sin usuario, parámetros ni fragmento; sin barra final', () => {
    expect(normalizePublicAssetsBaseUrl('https://minio-api.unac.edu.co/control-interno-public/', true)).toBe(
      'https://minio-api.unac.edu.co/control-interno-public',
    );
    expect(normalizePublicAssetsBaseUrl('http://127.0.0.1:19000/control-interno-public', false)).toBe(
      'http://127.0.0.1:19000/control-interno-public',
    );
    for (const [value, production] of [
      ['http://minio-api.unac.edu.co/x', true],
      ['ftp://x/y', false],
      ['https://u:p@x.co/b', false],
      ['https://x.co/b?y=1', false],
      ['https://x.co/b#f', false],
      ['no es url', false],
    ] as const) {
      expect(() => normalizePublicAssetsBaseUrl(value, production)).toThrow(PublicAssetsConfigError);
    }
  });

  it('nombre de bucket S3', () => {
    expect(normalizePublicAssetsBucket(' control-interno-public ')).toBe('control-interno-public');
    for (const value of ['CI', 'a', 'con espacio', 'x..y', '-x-', 'x/y']) {
      expect(() => normalizePublicAssetsBucket(value)).toThrow(PublicAssetsConfigError);
    }
  });

  it('URL pública = base + clave (segmentos codificados)', () => {
    expect(publicAssetUrl('https://h/b/', 'images/email/a b.png')).toBe('https://h/b/images/email/a%20b.png');
  });
});

describe('StorageService.putPublicAsset (cliente S3 simulado)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sube al bucket público con Content-Type y Cache-Control y devuelve la URL pública', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
    const { service } = build(S3_ROW);
    const stored = await service.putPublicAsset(INPUT);
    expect(stored).toEqual({
      key: INPUT.key,
      publicUrl: `https://minio-api.unac.edu.co/control-interno-public/${INPUT.key}`,
    });
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]?.[0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toMatchObject({
      Bucket: 'control-interno-public',
      Key: INPUT.key,
      ContentType: 'image/png',
      CacheControl: 'public, max-age=31536000, immutable',
    });
    expect(command.input.Bucket).not.toBe('control-interno');
  });

  it.each([
    ['driver project', { ...S3_ROW, driver: 'project' as const }],
    ['driver Google Drive', { ...S3_ROW, driver: 'google_drive' as const }],
    ['sin bucket público', { ...S3_ROW, s3PublicAssetsBucket: null }],
    ['sin URL pública base', { ...S3_ROW, s3PublicAssetsBaseUrl: null }],
    ['sin credenciales S3', { ...S3_ROW, s3AccessKey: null }],
  ])('%s: 409 PUBLIC_ASSETS_NOT_CONFIGURED y no sube nada', async (_name, row) => {
    const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
    const { service } = build(row);
    await expect(service.putPublicAsset(INPUT)).rejects.toMatchObject({ code: ErrorCode.PublicAssetsNotConfigured });
    expect(send).not.toHaveBeenCalled();
  });

  it('mismo bucket que documentos: la imagen va a images/email/ de ese bucket', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
    const { service } = build({
      ...S3_ROW,
      s3PublicAssetsBucket: 'control-interno',
      s3PublicAssetsBaseUrl: 'https://minio-api.unac.edu.co/control-interno',
    });
    const stored = await service.putPublicAsset(INPUT);
    expect(stored.publicUrl).toBe(`https://minio-api.unac.edu.co/control-interno/${INPUT.key}`);
    const command = send.mock.calls[0]?.[0] as PutObjectCommand;
    expect(command.input).toMatchObject({ Bucket: 'control-interno', Key: INPUT.key });
  });

  it.each([
    ['fuera de images/email/', 'documents/2026/OCI-01-55/2026-0001.pdf'],
    ['otra carpeta de images/', 'images/otra/x.png'],
    ['prefijo anterior', 'email-assets/3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b.png'],
  ])('putPublicAsset y deletePublicAsset rechazan una clave %s', async (_label, key) => {
    const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
    const { service } = build(S3_ROW);
    await expect(service.putPublicAsset({ ...INPUT, key })).rejects.toMatchObject({ code: ErrorCode.StorageKeyInvalid });
    await expect(service.deletePublicAsset(key)).rejects.toMatchObject({ code: ErrorCode.StorageKeyInvalid });
    expect(send).not.toHaveBeenCalled();
  });

  it('deletePublicAsset borra de images/email/ en el bucket de imágenes', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
    const { service } = build(S3_ROW);
    await service.deletePublicAsset(INPUT.key);
    const command = send.mock.calls[0]?.[0] as DeleteObjectCommand;
    expect(command).toBeInstanceOf(DeleteObjectCommand);
    expect(command.input).toMatchObject({ Bucket: 'control-interno-public', Key: INPUT.key });
  });

  it('put/delete de documentos rechazan claves bajo images/ (carpeta que puede ser pública)', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
    const { service } = build(S3_ROW);
    const body = Buffer.from('x');
    await expect(service.put({ key: INPUT.key, body, contentType: 'application/pdf' })).rejects.toMatchObject({
      code: ErrorCode.StorageKeyInvalid,
    });
    await expect(service.put({ key: 'images/x.pdf', body, contentType: 'application/pdf' })).rejects.toMatchObject({
      code: ErrorCode.StorageKeyInvalid,
    });
    await expect(service.delete(INPUT.key)).rejects.toMatchObject({ code: ErrorCode.StorageKeyInvalid });
    expect(send).not.toHaveBeenCalled();
  });

  it('una clave antigua guardada en la BD (email-assets/, document-templates/…) se sigue leyendo tal cual', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({
      Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) },
    } as never);
    const { service } = build(S3_ROW);
    const read = await service.getFrom('s3', 'document-templates/OCI-01-55/2026-09-02-v2-3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b.docx');
    expect([...read]).toEqual([1, 2, 3]);
    const command = send.mock.calls[0]?.[0] as GetObjectCommand;
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command.input.Key).toBe('document-templates/OCI-01-55/2026-09-02-v2-3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b.docx');
  });

  it('una falla del proveedor responde STORAGE_UNAVAILABLE', async () => {
    vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(new Error('AccessDenied'));
    const { service } = build(S3_ROW);
    await expect(service.putPublicAsset(INPUT)).rejects.toMatchObject({ code: ErrorCode.StorageUnavailable });
  });

  it('PATCH /storage/settings valida y guarda el bucket y la URL base; el estado los muestra', async () => {
    const row = { ...S3_ROW, s3PublicAssetsBucket: null, s3PublicAssetsBaseUrl: null };
    const { service, save } = build(row);
    await expect(
      service.updateSettings({ s3PublicAssetsBaseUrl: 'https://x.co/b?token=1' }, 'actor'),
    ).rejects.toMatchObject({ code: ErrorCode.ValidationFailed });
    await service.updateSettings(
      { s3PublicAssetsBucket: 'control-interno-public', s3PublicAssetsBaseUrl: 'https://minio-api.unac.edu.co/control-interno-public/' },
      'actor',
    );
    expect(save.mock.calls.at(-1)?.[0]).toMatchObject({
      s3PublicAssetsBucket: 'control-interno-public',
      s3PublicAssetsBaseUrl: 'https://minio-api.unac.edu.co/control-interno-public',
    });
    expect(await service.status()).toMatchObject({
      s3PublicAssetsBucket: 'control-interno-public',
      s3PublicAssetsBaseUrl: 'https://minio-api.unac.edu.co/control-interno-public',
    });
  });
});
