import { randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { isOutboundForbidden } from '../net/outbound-destination.js';

/**
 * Prueba de conexión de un almacenamiento (POST /storage/test). Cada comprobación tiene un nombre fijo y, si
 * falla, un código de STORAGE_TEST_ERROR_CODES; los mensajes son propios (nunca el texto del proveedor, que
 * puede traer el endpoint o la clave de acceso) y ninguno incluye secretos.
 */
export const STORAGE_CHECK_NAMES = [
  'CONFIGURATION',
  'DESTINATION',
  'ENDPOINT',
  'CREDENTIALS',
  'BUCKET',
  'WRITE',
  'READ',
  'DELETE',
  'VERSIONING',
  'OBJECT_LOCK',
] as const;
export type StorageCheckName = (typeof STORAGE_CHECK_NAMES)[number];

export const STORAGE_CHECK_STATUSES = ['PASSED', 'FAILED', 'WARNING', 'SKIPPED'] as const;
export type StorageCheckStatus = (typeof STORAGE_CHECK_STATUSES)[number];

export const STORAGE_TEST_ERROR_CODES = [
  'STORAGE_NOT_CONFIGURED',
  'OUTBOUND_DESTINATION_FORBIDDEN',
  'ENDPOINT_NOT_ALLOWED',
  'ENDPOINT_UNREACHABLE',
  'ENDPOINT_TIMEOUT',
  'TLS_CERTIFICATE_INVALID',
  'INVALID_CREDENTIALS',
  'ACCESS_DENIED',
  'BUCKET_NOT_FOUND',
  'CONTENT_MISMATCH',
  'UNEXPECTED_ERROR',
] as const;
export type StorageTestErrorCode = (typeof STORAGE_TEST_ERROR_CODES)[number];

export const BUCKET_VERSIONING_STATES = ['ENABLED', 'SUSPENDED', 'DISABLED', 'UNKNOWN'] as const;
export type BucketVersioningState = (typeof BUCKET_VERSIONING_STATES)[number];

export const BUCKET_OBJECT_LOCK_STATES = ['ENABLED', 'DISABLED', 'UNKNOWN'] as const;
export type BucketObjectLockState = (typeof BUCKET_OBJECT_LOCK_STATES)[number];

/** Prefijo reservado de los objetos de sonda: la política mínima solo concede s3:DeleteObject aquí. */
export const STORAGE_PROBE_PREFIX = 'health/';

export interface StorageCheck {
  readonly name: StorageCheckName;
  readonly status: StorageCheckStatus;
  readonly errorCode: StorageTestErrorCode | null;
  readonly message: string | null;
}

export interface BucketState {
  readonly versioning: BucketVersioningState;
  readonly objectLock: BucketObjectLockState;
}

export interface S3ProbeResult {
  readonly checks: ReadonlyArray<StorageCheck>;
  readonly bucket: BucketState;
}

export const passed = (name: StorageCheckName, message: string | null = null): StorageCheck => ({
  name,
  status: 'PASSED',
  errorCode: null,
  message,
});

export const failed = (name: StorageCheckName, errorCode: StorageTestErrorCode, message: string): StorageCheck => ({
  name,
  status: 'FAILED',
  errorCode,
  message,
});

export const warning = (name: StorageCheckName, errorCode: StorageTestErrorCode | null, message: string): StorageCheck => ({
  name,
  status: 'WARNING',
  errorCode,
  message,
});

export const skipped = (name: StorageCheckName): StorageCheck => ({
  name,
  status: 'SKIPPED',
  errorCode: null,
  message: null,
});

const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'CERT_UNTRUSTED',
  'CERT_SIGNATURE_FAILURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'EPROTO',
]);

const UNREACHABLE_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ERR_INVALID_URL',
]);

const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNABORTED', 'UND_ERR_CONNECT_TIMEOUT']);

const INVALID_CREDENTIAL_NAMES = new Set([
  'InvalidAccessKeyId',
  'SignatureDoesNotMatch',
  'InvalidToken',
  'ExpiredToken',
  'InvalidSecurity',
  'AuthorizationHeaderMalformed',
]);

const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

interface ErrorFacts {
  readonly code: string | null;
  readonly name: string | null;
  readonly httpStatus: number | null;
}

/** Código de red (err.code) de la cadena de causas y nombre/estado HTTP del error S3, sin mensajes. */
const factsOf = (error: unknown): ErrorFacts => {
  let code: string | null = null;
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    const candidate = (current as { code?: unknown }).code;
    if (typeof candidate === 'string' && code === null) {
      code = candidate;
    }
    current = (current as { cause?: unknown }).cause;
  }
  const record = (typeof error === 'object' && error !== null ? error : {}) as {
    name?: unknown;
    Code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  const rawName = typeof record.Code === 'string' ? record.Code : record.name;
  const name = typeof rawName === 'string' && ERROR_NAME.test(rawName) ? rawName : null;
  const status = record.$metadata?.httpStatusCode;
  return { code, name, httpStatus: typeof status === 'number' ? status : null };
};

export interface ClassifiedError {
  /** true si ni siquiera hubo respuesta HTTP del servidor. */
  readonly transport: boolean;
  readonly code: StorageTestErrorCode;
  readonly message: string;
}

/**
 * Traduce un error del cliente S3 a un código de prueba. El mensaje es fijo; como mucho repite el nombre del
 * error S3 (p. ej. `AuthorizationHeaderMalformed`), que no contiene datos.
 */
export const classifyS3Error = (error: unknown): ClassifiedError => {
  if (isOutboundForbidden(error)) {
    return {
      transport: true,
      code: 'OUTBOUND_DESTINATION_FORBIDDEN',
      message:
        'El endpoint resuelve a una red privada, loopback o link-local y el despliegue no lo autoriza (OUTBOUND_ALLOWED_HOSTS)',
    };
  }
  const facts = factsOf(error);
  if (facts.code && TLS_CODES.has(facts.code)) {
    return {
      transport: true,
      code: 'TLS_CERTIFICATE_INVALID',
      message: `El certificado TLS del endpoint no es válido (${facts.code})`,
    };
  }
  if (facts.name === 'TimeoutError' || (facts.code && TIMEOUT_CODES.has(facts.code))) {
    return { transport: true, code: 'ENDPOINT_TIMEOUT', message: 'El endpoint no respondió a tiempo' };
  }
  if (facts.code && UNREACHABLE_CODES.has(facts.code)) {
    return {
      transport: true,
      code: 'ENDPOINT_UNREACHABLE',
      message: `No se pudo conectar con el endpoint (${facts.code})`,
    };
  }
  if (facts.httpStatus === null) {
    return {
      transport: true,
      code: 'ENDPOINT_UNREACHABLE',
      message: 'No se obtuvo respuesta S3 del endpoint',
    };
  }
  if (facts.name && INVALID_CREDENTIAL_NAMES.has(facts.name)) {
    return {
      transport: false,
      code: 'INVALID_CREDENTIALS',
      message: `La clave de acceso o la clave secreta no son válidas (${facts.name})`,
    };
  }
  if (facts.name === 'NoSuchBucket' || (facts.httpStatus === 404 && facts.name === 'NotFound')) {
    return { transport: false, code: 'BUCKET_NOT_FOUND', message: 'El bucket no existe' };
  }
  if (facts.name === 'AccessDenied' || facts.httpStatus === 403) {
    return { transport: false, code: 'ACCESS_DENIED', message: 'La política de la clave no permite esta operación' };
  }
  return {
    transport: false,
    code: 'UNEXPECTED_ERROR',
    message: `Respuesta inesperada del servidor S3${facts.name ? ` (${facts.name})` : ''}${facts.httpStatus ? ` HTTP ${facts.httpStatus}` : ''}`,
  };
};

/** Lo único que la sonda necesita del cliente S3 (en pruebas unitarias, un doble). */
export type S3Send = (command: object) => Promise<unknown>;

const toBuffer = async (body: unknown): Promise<Buffer | null> => {
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  if (typeof body === 'object' && body !== null && 'transformToByteArray' in body) {
    return Buffer.from(await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray());
  }
  return null;
};

const ENDPOINT_OK = 'El endpoint respondió';

/**
 * Comprobaciones reales contra el bucket, en orden: alcance/credenciales/bucket (ListObjectsV2 con el prefijo de
 * sonda, que devuelve códigos de error con cuerpo, a diferencia de HeadBucket), escritura, lectura y borrado de un
 * objeto `health/probe-<uuid>.txt`, versionado y object lock. Una falla de transporte o de credenciales corta el
 * resto (quedan SKIPPED); la falta de s3:ListBucket solo es aviso porque la aplicación no la necesita.
 */
export const runS3Probe = async (send: S3Send, bucket: string): Promise<S3ProbeResult> => {
  const checks: StorageCheck[] = [];
  const unknownBucket: BucketState = { versioning: 'UNKNOWN', objectLock: 'UNKNOWN' };
  const skipFrom = (names: ReadonlyArray<StorageCheckName>): S3ProbeResult => ({
    checks: [...checks, ...names.map(skipped)],
    bucket: unknownBucket,
  });

  try {
    await send(new ListObjectsV2Command({ Bucket: bucket, Prefix: STORAGE_PROBE_PREFIX, MaxKeys: 1 }));
    checks.push(passed('ENDPOINT', ENDPOINT_OK), passed('CREDENTIALS'), passed('BUCKET'));
  } catch (error) {
    const classified = classifyS3Error(error);
    if (classified.transport) {
      checks.push(failed('ENDPOINT', classified.code, classified.message));
      return skipFrom(['CREDENTIALS', 'BUCKET', 'WRITE', 'READ', 'DELETE', 'VERSIONING', 'OBJECT_LOCK']);
    }
    checks.push(passed('ENDPOINT', ENDPOINT_OK));
    if (classified.code === 'INVALID_CREDENTIALS') {
      checks.push(failed('CREDENTIALS', classified.code, classified.message));
      return skipFrom(['BUCKET', 'WRITE', 'READ', 'DELETE', 'VERSIONING', 'OBJECT_LOCK']);
    }
    checks.push(passed('CREDENTIALS'));
    if (classified.code === 'BUCKET_NOT_FOUND') {
      checks.push(failed('BUCKET', classified.code, classified.message));
      return skipFrom(['WRITE', 'READ', 'DELETE', 'VERSIONING', 'OBJECT_LOCK']);
    }
    if (classified.code === 'ACCESS_DENIED') {
      checks.push(
        warning(
          'BUCKET',
          classified.code,
          'Sin permiso s3:ListBucket no se puede confirmar que el bucket exista; se prueba igual escribir en él',
        ),
      );
    } else {
      checks.push(failed('BUCKET', classified.code, classified.message));
      return skipFrom(['WRITE', 'READ', 'DELETE', 'VERSIONING', 'OBJECT_LOCK']);
    }
  }

  const key = `${STORAGE_PROBE_PREFIX}probe-${randomUUID()}.txt`;
  const payload = Buffer.from(`control-interno storage probe ${new Date().toISOString()}`);
  let written = false;
  try {
    await send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: payload, ContentType: 'text/plain' }));
    written = true;
    checks.push(passed('WRITE'));
  } catch (error) {
    const classified = classifyS3Error(error);
    checks.push(failed('WRITE', classified.code, classified.message));
  }

  if (written) {
    try {
      const result = (await send(new GetObjectCommand({ Bucket: bucket, Key: key }))) as { Body?: unknown };
      const read = await toBuffer(result.Body);
      checks.push(
        read && read.equals(payload)
          ? passed('READ')
          : failed('READ', 'CONTENT_MISMATCH', 'El objeto leído no coincide con el escrito'),
      );
    } catch (error) {
      const classified = classifyS3Error(error);
      checks.push(failed('READ', classified.code, classified.message));
    }
    try {
      await send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      checks.push(passed('DELETE'));
    } catch (error) {
      const classified = classifyS3Error(error);
      checks.push(failed('DELETE', classified.code, classified.message));
    }
  } else {
    checks.push(skipped('READ'), skipped('DELETE'));
  }

  let versioning: BucketVersioningState = 'UNKNOWN';
  try {
    const result = (await send(new GetBucketVersioningCommand({ Bucket: bucket }))) as { Status?: unknown };
    versioning = result.Status === 'Enabled' ? 'ENABLED' : result.Status === 'Suspended' ? 'SUSPENDED' : 'DISABLED';
    checks.push(
      versioning === 'ENABLED'
        ? passed('VERSIONING', 'Versionado activo')
        : warning(
            'VERSIONING',
            null,
            versioning === 'SUSPENDED'
              ? 'El versionado está suspendido: un archivo sobrescrito o borrado no se puede recuperar'
              : 'El versionado no está activo: un archivo sobrescrito o borrado no se puede recuperar',
          ),
    );
  } catch (error) {
    const classified = classifyS3Error(error);
    checks.push(warning('VERSIONING', classified.code, 'No se pudo consultar el versionado del bucket'));
  }

  let objectLock: BucketObjectLockState = 'UNKNOWN';
  try {
    const result = (await send(new GetObjectLockConfigurationCommand({ Bucket: bucket }))) as {
      ObjectLockConfiguration?: { ObjectLockEnabled?: unknown };
    };
    objectLock = result.ObjectLockConfiguration?.ObjectLockEnabled === 'Enabled' ? 'ENABLED' : 'DISABLED';
  } catch (error) {
    const facts = factsOf(error);
    if (facts.name === 'ObjectLockConfigurationNotFoundError' || facts.name === 'ObjectLockConfigurationNotFound') {
      objectLock = 'DISABLED';
    } else {
      const classified = classifyS3Error(error);
      checks.push(warning('OBJECT_LOCK', classified.code, 'No se pudo consultar object lock del bucket'));
    }
  }
  if (objectLock !== 'UNKNOWN') {
    checks.push(
      passed('OBJECT_LOCK', objectLock === 'ENABLED' ? 'Object lock activo' : 'Object lock no está activo (opcional)'),
    );
  }

  return { checks, bucket: { versioning, objectLock } };
};
