import { ApiProperty } from '@nestjs/swagger';
import { STORAGE_DRIVERS } from '../../../modules/documents/dto/document.responses.js';
import {
  BUCKET_OBJECT_LOCK_STATES,
  BUCKET_VERSIONING_STATES,
  STORAGE_CHECK_NAMES,
  STORAGE_CHECK_STATUSES,
  STORAGE_TEST_ERROR_CODES,
} from '../s3-connection-probe.js';

/** Respuesta de POST /storage/test. Documenta lo que devuelve StorageService.testConnection. */

export class StorageCheckDto {
  @ApiProperty({
    enum: STORAGE_CHECK_NAMES,
    enumName: 'StorageCheckName',
    description:
      'CONFIGURATION: bucket y claves presentes. DESTINATION: endpoint permitido por BE-16 (red privada solo con OUTBOUND_ALLOWED_HOSTS; en producción https salvo host autorizado). ENDPOINT: el servidor respondió. CREDENTIALS: la clave de acceso y la secreta son válidas. BUCKET: el bucket existe. WRITE/READ/DELETE: objeto de sonda health/probe-<uuid>.txt. VERSIONING y OBJECT_LOCK: estado del bucket (informativo). Con drivers distintos de s3 solo CONFIGURATION, DESTINATION (SKIPPED), WRITE, READ y DELETE.',
  })
  readonly name!: (typeof STORAGE_CHECK_NAMES)[number];

  @ApiProperty({
    enum: STORAGE_CHECK_STATUSES,
    enumName: 'StorageCheckStatus',
    description: 'FAILED hace ok=false. WARNING no (p. ej. versionado inactivo o sin s3:ListBucket). SKIPPED: no se llegó a probar',
  })
  readonly status!: (typeof STORAGE_CHECK_STATUSES)[number];

  @ApiProperty({
    enum: STORAGE_TEST_ERROR_CODES,
    enumName: 'StorageTestErrorCode',
    nullable: true,
    description:
      'Causa si status es FAILED o WARNING. STORAGE_NOT_CONFIGURED: faltan bucket o claves. OUTBOUND_DESTINATION_FORBIDDEN: endpoint en red interna no autorizada (BE-16). ENDPOINT_NOT_ALLOWED: URL inválida o http en producción sin autorización. ENDPOINT_UNREACHABLE: DNS, conexión rechazada o sin respuesta S3. ENDPOINT_TIMEOUT. TLS_CERTIFICATE_INVALID. INVALID_CREDENTIALS: clave de acceso o secreta erróneas. ACCESS_DENIED: la política no concede la operación. BUCKET_NOT_FOUND. CONTENT_MISMATCH: lo leído no es lo escrito. UNEXPECTED_ERROR',
  })
  readonly errorCode!: (typeof STORAGE_TEST_ERROR_CODES)[number] | null;

  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'Texto para mostrar. Nunca incluye claves, endpoint ni el mensaje crudo del proveedor',
  })
  readonly message!: string | null;
}

export class StorageBucketStateDto {
  @ApiProperty({
    enum: BUCKET_VERSIONING_STATES,
    enumName: 'StorageBucketVersioning',
    description: 'DISABLED: nunca se activó. UNKNOWN: la clave no puede consultarlo (s3:GetBucketVersioning)',
  })
  readonly versioning!: (typeof BUCKET_VERSIONING_STATES)[number];

  @ApiProperty({
    enum: BUCKET_OBJECT_LOCK_STATES,
    enumName: 'StorageBucketObjectLock',
    description: 'UNKNOWN: la clave no puede consultarlo (s3:GetBucketObjectLockConfiguration)',
  })
  readonly objectLock!: (typeof BUCKET_OBJECT_LOCK_STATES)[number];
}

export class StorageTestResultDto {
  @ApiProperty({ description: 'true si ninguna comprobación terminó en FAILED' })
  readonly ok!: boolean;

  @ApiProperty({ enum: STORAGE_DRIVERS, enumName: 'DocumentStorageDriver', description: 'Driver activo que se probó' })
  readonly driver!: (typeof STORAGE_DRIVERS)[number];

  @ApiProperty({ format: 'date-time' })
  readonly checkedAt!: string;

  @ApiProperty({ type: [StorageCheckDto], description: 'En el orden en que se ejecutan' })
  readonly checks!: ReadonlyArray<StorageCheckDto>;

  @ApiProperty({
    type: StorageBucketStateDto,
    nullable: true,
    description: 'Solo S3; null con otros drivers o si la prueba se detuvo antes de contactar el servidor',
  })
  readonly bucket!: StorageBucketStateDto | null;
}
