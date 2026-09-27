import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import { afterAll, describe, expect, it } from 'vitest';
import { ErrorCode } from '../../src/common/constants/error-code.enum.js';
import type { AppConfig } from '../../src/config/configuration.js';
import { SecretCipherService } from '../../src/shared/crypto/secret-cipher.service.js';
import { OutboundDestinationError, type OutboundPolicy } from '../../src/shared/net/outbound-destination.js';
import { S3StorageAdapter, type S3AdapterConfig } from '../../src/shared/storage/adapters/s3-storage.adapter.js';
import type { StorageSettings } from '../../src/shared/storage/entities/storage-settings.entity.js';
import { StorageService } from '../../src/shared/storage/storage.service.js';

/**
 * Driver S3 contra un MinIO real. Se salta si no hay S3_TEST_ENDPOINT. Preparación (ver docs/DEPLOY.md §10):
 * bucket privado con versionado y un usuario con la política mínima (DeleteObject solo en health/*).
 *   S3_TEST_ENDPOINT=http://127.0.0.1:19000 S3_TEST_BUCKET=control-interno
 *   S3_TEST_ACCESS_KEY=<usuario de servicio> S3_TEST_SECRET_KEY=<su clave>
 * Imágenes de correo (§10.7), opcional: bucket público con lectura anónima solo de email-assets/* y la política de la
 * aplicación que permite escribir ahí.
 *   S3_TEST_PUBLIC_BUCKET=control-interno-public [S3_TEST_PUBLIC_BASE_URL=<endpoint>/control-interno-public]
 */
const endpoint = process.env['S3_TEST_ENDPOINT'] ?? '';
const bucket = process.env['S3_TEST_BUCKET'] ?? 'control-interno';
const accessKey = process.env['S3_TEST_ACCESS_KEY'] ?? '';
const secretKey = process.env['S3_TEST_SECRET_KEY'] ?? '';
const region = process.env['S3_TEST_REGION'] ?? 'us-east-1';
const publicBucket = process.env['S3_TEST_PUBLIC_BUCKET'] ?? '';
const publicBaseUrl = process.env['S3_TEST_PUBLIC_BASE_URL'] ?? `${endpoint}/${publicBucket}`;

const DEV: OutboundPolicy = { allowPrivateNetworks: true, allowedHosts: [] };
const PROD: OutboundPolicy = { allowPrivateNetworks: false, allowedHosts: [] };

const adapterConfig = (overrides: Partial<S3AdapterConfig> = {}): S3AdapterConfig => ({
  provider: 'minio',
  endpoint,
  region,
  bucket,
  accessKey,
  secretKey,
  forcePathStyle: true,
  ...overrides,
});

const run = Date.now().toString(36);
// Espacios, tildes, ñ, +, &, =, %, paréntesis y comillas: todo lo que admite assertSafeStorageKey.
const SPECIAL = `Acta nº 5 (firmada) — Peña & Cía + 100% = "ok" 'v2'.pdf`;

describe.runIf(Boolean(endpoint))('Driver S3 contra MinIO real', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'be-minio-project-'));

  afterAll(() => rmSync(projectRoot, { recursive: true, force: true }));

  /** StorageService con una fila storage_settings en memoria que el test puede cambiar (como la pantalla). */
  const serviceWith = (row: Partial<StorageSettings>, outbound: OutboundPolicy) => {
    const settings = {
      find: async () => [row],
      save: async (value: StorageSettings) => Object.assign(row, value),
      create: (value: Partial<StorageSettings>) => ({ ...value }),
    } as unknown as Repository<StorageSettings>;
    const values: Record<string, unknown> = {
      storage: {
        driver: 'project',
        projectPath: projectRoot,
        s3: { provider: 'minio', endpoint: null, region, bucket: null, accessKey: null, secretKey: null, forcePathStyle: true },
        google: { clientId: null, clientSecret: null, refreshToken: null, folderId: null },
        onedrive: { tenantId: null, clientId: null, clientSecret: null, refreshToken: null, folderId: null },
      },
      apiPublicUrl: 'http://api.test',
      outbound,
      settingsEncryptionKey: 'aW50ZWdyYXRpb24tc2V0dGluZ3Mta2V5LTMyYnl0ZXM=',
      settingsEncryptionPreviousKeys: [],
    };
    const config = { getOrThrow: (key: string) => values[key] } as unknown as ConfigService<AppConfig, true>;
    return new StorageService(settings, config, new SecretCipherService(config));
  };

  const s3Row = (extra: Partial<StorageSettings> = {}): Partial<StorageSettings> => ({
    driver: 's3',
    projectPath: projectRoot,
    s3Provider: 'minio',
    s3Endpoint: endpoint,
    s3Region: region,
    s3Bucket: bucket,
    s3AccessKey: accessKey,
    s3SecretKey: secretKey,
    s3ForcePathStyle: true,
    ...extra,
  });

  it('put / get / exists con una clave con caracteres especiales; el bucket es privado', async () => {
    const adapter = new S3StorageAdapter(adapterConfig(), DEV);
    const key = `it/${run}/${SPECIAL}`;
    const body = Buffer.from(`contenido ${run} ñ`);
    const stored = await adapter.put({ key, body, contentType: 'application/pdf' });
    expect(stored).toMatchObject({ key, driver: 's3', byteSize: body.byteLength });
    expect((await adapter.get(key)).equals(body)).toBe(true);
    expect(await adapter.exists(key)).toBe(true);
    expect(await adapter.exists(`it/${run}/no-existe.pdf`)).toBe(false);

    // Sin firma: el bucket no es público.
    const anonymous = await fetch(`${endpoint}/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`);
    expect(anonymous.status).toBe(403);
  });

  it('política mínima: la clave de la aplicación borra en health/ pero no un documento', async () => {
    const adapter = new S3StorageAdapter(adapterConfig(), DEV);
    const probeKey = `health/it-${run}-${SPECIAL}`;
    await adapter.put({ key: probeKey, body: Buffer.from('x'), contentType: 'text/plain' });
    await adapter.delete(probeKey);
    expect(await adapter.exists(probeKey)).toBe(false);

    const documentKey = `it/${run}/documento.pdf`;
    await adapter.put({ key: documentKey, body: Buffer.from('pdf'), contentType: 'application/pdf' });
    await expect(adapter.delete(documentKey)).rejects.toMatchObject({ name: 'AccessDenied' });
    expect(await adapter.exists(documentKey)).toBe(true);
  });

  it('BE-16: en producción sin OUTBOUND_ALLOWED_HOSTS el endpoint interno se rechaza; con el host autorizado funciona', async () => {
    const host = new URL(endpoint).hostname;
    expect(() => new S3StorageAdapter(adapterConfig(), PROD)).toThrow(OutboundDestinationError);

    const allowed = new S3StorageAdapter(adapterConfig(), { allowPrivateNetworks: false, allowedHosts: [host] });
    const key = `it/${run}/allowlist.txt`;
    await allowed.put({ key, body: Buffer.from('ok'), contentType: 'text/plain' });
    expect((await allowed.get(key)).toString()).toBe('ok');

    // Por nombre (pasa por guardedLookup en cada conexión): localhost autorizado explícitamente.
    const byName = new S3StorageAdapter(
      adapterConfig({ endpoint: endpoint.replace(host, 'localhost') }),
      { allowPrivateNetworks: false, allowedHosts: ['localhost'] },
    );
    expect(await byName.exists(key)).toBe(true);
  });

  it('Probar conexión: todo PASSED con versionado activo, sin object lock', async () => {
    const result = await serviceWith(s3Row(), DEV).testConnection();
    expect(result.ok).toBe(true);
    expect(result.checks.map((check) => [check.name, check.status])).toEqual([
      ['CONFIGURATION', 'PASSED'],
      ['DESTINATION', 'PASSED'],
      ['ENDPOINT', 'PASSED'],
      ['CREDENTIALS', 'PASSED'],
      ['BUCKET', 'PASSED'],
      ['WRITE', 'PASSED'],
      ['READ', 'PASSED'],
      ['DELETE', 'PASSED'],
      ['VERSIONING', 'PASSED'],
      ['OBJECT_LOCK', 'PASSED'],
    ]);
    expect(result.bucket).toEqual({ versioning: 'ENABLED', objectLock: 'DISABLED' });
    expect(JSON.stringify(result)).not.toContain(secretKey);
  });

  it('Probar conexión en producción: rechazado sin allowlist, correcto con el host en OUTBOUND_ALLOWED_HOSTS', async () => {
    const host = new URL(endpoint).hostname;
    const denied = await serviceWith(s3Row(), PROD).testConnection();
    expect(denied.ok).toBe(false);
    expect(denied.checks[1]).toMatchObject({ name: 'DESTINATION', errorCode: 'OUTBOUND_DESTINATION_FORBIDDEN' });

    const allowed = await serviceWith(s3Row(), { allowPrivateNetworks: false, allowedHosts: [host] }).testConnection();
    expect(allowed.ok).toBe(true);
  });

  it('Probar conexión: clave secreta errónea, bucket inexistente y endpoint caído', async () => {
    const wrongSecret = await serviceWith(s3Row({ s3SecretKey: `${secretKey}x` }), DEV).testConnection();
    expect(wrongSecret.checks.find((check) => check.name === 'CREDENTIALS')).toMatchObject({
      status: 'FAILED',
      errorCode: 'INVALID_CREDENTIALS',
    });

    const missing = await serviceWith(s3Row({ s3Bucket: `no-existe-${run}` }), DEV).testConnection();
    const bucketCheck = missing.checks.find((check) => check.name === 'BUCKET');
    // Con la política mínima el usuario no tiene ListBucket sobre otro bucket: MinIO responde AccessDenied.
    expect(['BUCKET_NOT_FOUND', 'ACCESS_DENIED']).toContain(bucketCheck?.errorCode);
    expect(missing.ok).toBe(false);

    const down = await serviceWith(s3Row({ s3Endpoint: 'http://127.0.0.1:1' }), DEV).testConnection();
    expect(down.checks.find((check) => check.name === 'ENDPOINT')).toMatchObject({
      status: 'FAILED',
      errorCode: 'ENDPOINT_UNREACHABLE',
    });
  });

  // Opcional: un bucket creado con `mc mb --with-lock` y una clave que pueda consultarlo.
  it.runIf(Boolean(process.env['S3_TEST_LOCK_BUCKET']))('Probar conexión detecta object lock', async () => {
    const result = await serviceWith(
      s3Row({
        s3Bucket: process.env['S3_TEST_LOCK_BUCKET'] ?? '',
        s3AccessKey: process.env['S3_TEST_LOCK_ACCESS_KEY'] ?? accessKey,
        s3SecretKey: process.env['S3_TEST_LOCK_SECRET_KEY'] ?? secretKey,
      }),
      DEV,
    ).testConnection();
    expect(result.bucket).toEqual({ versioning: 'ENABLED', objectLock: 'ENABLED' });
  });

  it('continuidad: tras pasar de project a s3, lo guardado antes se lee por su driver y lo nuevo va a MinIO', async () => {
    const row: Partial<StorageSettings> = { ...s3Row(), driver: 'project' };
    const service = serviceWith(row, DEV);
    const before = await service.put({ key: `generated/${run}/antes.pdf`, body: Buffer.from('antes'), contentType: 'application/pdf' });
    expect(before.driver).toBe('project');

    row.driver = 's3'; // lo que hace guardar driver=s3 desde la pantalla de Almacenamiento
    const after = await service.put({ key: `generated/${run}/despues.pdf`, body: Buffer.from('despues'), contentType: 'application/pdf' });
    expect(after.driver).toBe('s3');
    expect(await new S3StorageAdapter(adapterConfig(), DEV).exists(after.key)).toBe(true);

    expect((await service.getFrom(before.driver, before.key)).toString()).toBe('antes');
    expect((await service.getFrom(after.driver, after.key)).toString()).toBe('despues');
    // Leer con el driver activo (get) ya no encuentra lo anterior: por eso todo documento guarda su driver.
    await expect(service.get(before.key)).rejects.toMatchObject({ code: ErrorCode.ResourceNotFound });
  });

  describe.runIf(Boolean(publicBucket))('bucket público de imágenes de correo', () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    );

    it('putPublicAsset sube a email-assets/ del bucket público y la URL se abre sin firma con sus cabeceras', async () => {
      const service = serviceWith(s3Row({ s3PublicAssetsBucket: publicBucket, s3PublicAssetsBaseUrl: publicBaseUrl }), DEV);
      const key = `email-assets/${crypto.randomUUID()}.png`;
      const stored = await service.putPublicAsset({
        key,
        body: png,
        contentType: 'image/png',
        cacheControl: 'public, max-age=31536000, immutable',
      });
      expect(stored).toEqual({ key, publicUrl: `${publicBaseUrl}/${key}` });
      const anonymous = await fetch(stored.publicUrl);
      expect(anonymous.status).toBe(200);
      expect(anonymous.headers.get('content-type')).toBe('image/png');
      expect(anonymous.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(Buffer.from(await anonymous.arrayBuffer()).equals(png)).toBe(true);
    });

    it('el bucket público no se puede listar sin firma y el de documentos sigue privado', async () => {
      expect((await fetch(`${endpoint}/${publicBucket}?list-type=2`)).status).toBe(403);
      expect((await fetch(`${endpoint}/${bucket}?list-type=2`)).status).toBe(403);
    });

    it('sin bucket público configurado: PUBLIC_ASSETS_NOT_CONFIGURED', async () => {
      await expect(
        serviceWith(s3Row(), DEV).putPublicAsset({
          key: `email-assets/${crypto.randomUUID()}.png`,
          body: png,
          contentType: 'image/png',
          cacheControl: 'public, max-age=31536000, immutable',
        }),
      ).rejects.toMatchObject({ code: ErrorCode.PublicAssetsNotConfigured });
    });
  });
});
