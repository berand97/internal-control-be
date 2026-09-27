import { describe, expect, it } from 'vitest';
import { OutboundDestinationError } from '../net/outbound-destination.js';
import { classifyS3Error, runS3Probe, type S3Send } from './s3-connection-probe.js';

/** Error como los que lanza @aws-sdk/client-s3 ante una respuesta del servidor. */
const s3Error = (name: string, httpStatusCode: number) =>
  Object.assign(new Error(`${name}: detalle del proveedor con AKIAEXAMPLE y http://10.0.0.5:9000`), {
    name,
    $metadata: { httpStatusCode },
  });

/** Error de red de node (sin respuesta HTTP). */
const netError = (code: string) => Object.assign(new Error(`${code} 10.0.0.5:9000`), { code });

type Handler = (input: Record<string, unknown>) => unknown;

/** Doble del cliente S3: responde según el nombre del comando; guarda lo escrito para devolverlo al leer. */
const fakeS3 = (overrides: Partial<Record<string, Handler>> = {}) => {
  const objects = new Map<string, Buffer>();
  const calls: string[] = [];
  const defaults: Record<string, Handler> = {
    ListObjectsV2Command: () => ({ KeyCount: 0 }),
    PutObjectCommand: (input) => {
      objects.set(String(input['Key']), Buffer.from(input['Body'] as Buffer));
      return {};
    },
    GetObjectCommand: (input) => ({
      Body: { transformToByteArray: async () => new Uint8Array(objects.get(String(input['Key'])) ?? Buffer.alloc(0)) },
    }),
    DeleteObjectCommand: (input) => {
      objects.delete(String(input['Key']));
      return {};
    },
    GetBucketVersioningCommand: () => ({ Status: 'Enabled' }),
    GetObjectLockConfigurationCommand: () => {
      throw s3Error('ObjectLockConfigurationNotFoundError', 404);
    },
  };
  const send: S3Send = async (command) => {
    const name = command.constructor.name;
    calls.push(name);
    const handler = overrides[name] ?? defaults[name];
    if (!handler) {
      throw new Error(`comando inesperado ${name}`);
    }
    return handler((command as { input: Record<string, unknown> }).input);
  };
  return { send, objects, calls };
};

const statusOf = (result: Awaited<ReturnType<typeof runS3Probe>>) =>
  Object.fromEntries(result.checks.map((check) => [check.name, check.status]));

describe('runS3Probe (doble del cliente S3)', () => {
  it('bucket sano con versionado: todo PASSED, borra la sonda y reporta el estado del bucket', async () => {
    const { send, objects, calls } = fakeS3();
    const result = await runS3Probe(send, 'control-interno');
    expect(statusOf(result)).toEqual({
      ENDPOINT: 'PASSED',
      CREDENTIALS: 'PASSED',
      BUCKET: 'PASSED',
      WRITE: 'PASSED',
      READ: 'PASSED',
      DELETE: 'PASSED',
      VERSIONING: 'PASSED',
      OBJECT_LOCK: 'PASSED',
    });
    expect(result.bucket).toEqual({ versioning: 'ENABLED', objectLock: 'DISABLED' });
    expect(objects.size).toBe(0);
    expect(calls).toContain('DeleteObjectCommand');
  });

  it('la sonda se escribe bajo health/ (el único prefijo donde la política mínima permite borrar)', async () => {
    const keys: string[] = [];
    const { send } = fakeS3({
      PutObjectCommand: (input) => {
        keys.push(String(input['Key']));
        throw s3Error('AccessDenied', 403);
      },
    });
    await runS3Probe(send, 'b');
    expect(keys[0]).toMatch(/^health\/probe-[0-9a-f-]{36}\.txt$/);
  });

  it('endpoint inalcanzable: ENDPOINT FAILED ENDPOINT_UNREACHABLE y el resto SKIPPED', async () => {
    const { send } = fakeS3({ ListObjectsV2Command: () => { throw netError('ECONNREFUSED'); } });
    const result = await runS3Probe(send, 'b');
    expect(result.checks[0]).toMatchObject({ name: 'ENDPOINT', status: 'FAILED', errorCode: 'ENDPOINT_UNREACHABLE' });
    expect(result.checks.slice(1).every((check) => check.status === 'SKIPPED')).toBe(true);
    expect(result.bucket).toEqual({ versioning: 'UNKNOWN', objectLock: 'UNKNOWN' });
  });

  it('certificado TLS inválido: TLS_CERTIFICATE_INVALID', async () => {
    const { send } = fakeS3({ ListObjectsV2Command: () => { throw netError('DEPTH_ZERO_SELF_SIGNED_CERT'); } });
    const result = await runS3Probe(send, 'b');
    expect(result.checks[0]).toMatchObject({ name: 'ENDPOINT', errorCode: 'TLS_CERTIFICATE_INVALID' });
  });

  it('DNS que resuelve a red privada en cada conexión (BE-16): OUTBOUND_DESTINATION_FORBIDDEN', async () => {
    const wrapped = Object.assign(new Error('socket'), { cause: new OutboundDestinationError() });
    const { send } = fakeS3({ ListObjectsV2Command: () => { throw wrapped; } });
    const result = await runS3Probe(send, 'b');
    expect(result.checks[0]).toMatchObject({ name: 'ENDPOINT', errorCode: 'OUTBOUND_DESTINATION_FORBIDDEN' });
  });

  it('clave secreta errónea: CREDENTIALS FAILED INVALID_CREDENTIALS', async () => {
    const { send } = fakeS3({ ListObjectsV2Command: () => { throw s3Error('SignatureDoesNotMatch', 403); } });
    const result = await runS3Probe(send, 'b');
    expect(statusOf(result)).toMatchObject({ ENDPOINT: 'PASSED', CREDENTIALS: 'FAILED', BUCKET: 'SKIPPED', WRITE: 'SKIPPED' });
    expect(result.checks[1]?.errorCode).toBe('INVALID_CREDENTIALS');
  });

  it('bucket inexistente: BUCKET FAILED BUCKET_NOT_FOUND', async () => {
    const { send } = fakeS3({ ListObjectsV2Command: () => { throw s3Error('NoSuchBucket', 404); } });
    const result = await runS3Probe(send, 'b');
    expect(result.checks[2]).toMatchObject({ name: 'BUCKET', status: 'FAILED', errorCode: 'BUCKET_NOT_FOUND' });
  });

  it('sin s3:ListBucket: BUCKET es solo aviso y se sigue probando escribir/leer/borrar', async () => {
    const { send } = fakeS3({ ListObjectsV2Command: () => { throw s3Error('AccessDenied', 403); } });
    const result = await runS3Probe(send, 'b');
    expect(statusOf(result)).toMatchObject({ BUCKET: 'WARNING', WRITE: 'PASSED', READ: 'PASSED', DELETE: 'PASSED' });
  });

  it('sin permiso de borrado: DELETE FAILED ACCESS_DENIED', async () => {
    const { send } = fakeS3({ DeleteObjectCommand: () => { throw s3Error('AccessDenied', 403); } });
    const result = await runS3Probe(send, 'b');
    expect(result.checks.find((check) => check.name === 'DELETE')).toMatchObject({
      status: 'FAILED',
      errorCode: 'ACCESS_DENIED',
    });
  });

  it('lo leído no coincide con lo escrito: READ FAILED CONTENT_MISMATCH', async () => {
    const { send } = fakeS3({
      GetObjectCommand: () => ({ Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } }),
    });
    const result = await runS3Probe(send, 'b');
    expect(result.checks.find((check) => check.name === 'READ')).toMatchObject({ errorCode: 'CONTENT_MISMATCH' });
  });

  it('versionado sin activar o suspendido: WARNING, no FAILED', async () => {
    for (const [status, state] of [[undefined, 'DISABLED'], ['Suspended', 'SUSPENDED']] as const) {
      const { send } = fakeS3({ GetBucketVersioningCommand: () => ({ Status: status }) });
      const result = await runS3Probe(send, 'b');
      expect(result.bucket.versioning).toBe(state);
      expect(result.checks.find((check) => check.name === 'VERSIONING')?.status).toBe('WARNING');
      expect(result.checks.some((check) => check.status === 'FAILED')).toBe(false);
    }
  });

  it('object lock activo y consultas denegadas', async () => {
    const enabled = await runS3Probe(
      fakeS3({ GetObjectLockConfigurationCommand: () => ({ ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' } }) }).send,
      'b',
    );
    expect(enabled.bucket.objectLock).toBe('ENABLED');
    const denied = await runS3Probe(
      fakeS3({
        GetBucketVersioningCommand: () => { throw s3Error('AccessDenied', 403); },
        GetObjectLockConfigurationCommand: () => { throw s3Error('AccessDenied', 403); },
      }).send,
      'b',
    );
    expect(denied.bucket).toEqual({ versioning: 'UNKNOWN', objectLock: 'UNKNOWN' });
    expect(statusOf(denied)).toMatchObject({ VERSIONING: 'WARNING', OBJECT_LOCK: 'WARNING' });
  });

  it('los mensajes nunca repiten el texto del proveedor (claves, endpoint)', async () => {
    const { send } = fakeS3({ ListObjectsV2Command: () => { throw s3Error('InvalidAccessKeyId', 403); } });
    const result = await runS3Probe(send, 'b');
    const text = JSON.stringify(result);
    expect(text).not.toContain('AKIAEXAMPLE');
    expect(text).not.toContain('10.0.0.5');
  });
});

describe('classifyS3Error', () => {
  it.each([
    [netError('ENOTFOUND'), 'ENDPOINT_UNREACHABLE', true],
    [netError('ETIMEDOUT'), 'ENDPOINT_TIMEOUT', true],
    [Object.assign(new Error('x'), { name: 'TimeoutError' }), 'ENDPOINT_TIMEOUT', true],
    [netError('ERR_TLS_CERT_ALTNAME_INVALID'), 'TLS_CERTIFICATE_INVALID', true],
    [netError('CERT_HAS_EXPIRED'), 'TLS_CERTIFICATE_INVALID', true],
    [s3Error('InvalidAccessKeyId', 403), 'INVALID_CREDENTIALS', false],
    [s3Error('NotFound', 404), 'BUCKET_NOT_FOUND', false],
    [s3Error('Forbidden', 403), 'ACCESS_DENIED', false],
    [s3Error('InternalError', 500), 'UNEXPECTED_ERROR', false],
  ])('%s → %s', (error, code, transport) => {
    expect(classifyS3Error(error)).toMatchObject({ code, transport });
  });
});
