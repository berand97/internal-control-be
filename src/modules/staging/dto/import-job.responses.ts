import { ApiProperty, getSchemaPath } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger';
import { ApiSuccessEnvelope } from '../../../common/swagger/api-envelopes.js';
import { MAIL_OUTBOX_STATUSES } from '../../../shared/mail/mail-outbox.service.js';
import { IMPORT_TARGETS } from '../import/import-fields.js';
import { IMPORT_JOB_PHASES, IMPORT_JOB_STATUSES } from '../services/import-jobs.service.js';
import { ImportResultDto } from './import.responses.js';

/**
 * Esquemas de respuesta de los trabajos de importación (POST confirm, /imports/jobs). Solo documentan lo que
 * ImportJobsService ya devuelve (ImportJobView): cambiar un shape exige cambiar ambos.
 */

export class ImportJobProgressDto {
  @ApiProperty({
    type: 'integer',
    nullable: true,
    description: 'ASSETS: movimientos de registro por escribir, conocido al terminar la fase ROWS. null antes, y siempre en COST_CENTERS/PERSONS',
  })
  readonly movementsTotal!: number | null;

  @ApiProperty({ type: 'integer', description: 'Movimientos escritos (acumulado entre intentos)' })
  readonly movementsDone!: number;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    minimum: 0,
    maximum: 100,
    description:
      '0 en QUEUED; en MOVEMENTS movementsDone/movementsTotal (máx. 99); 100 cuando status=SUCCEEDED; null cuando no se puede medir (ROWS, FINALIZING, o FAILED fuera de MOVEMENTS): barra indeterminada',
  })
  readonly percent!: number | null;
}

export class ImportJobRowsDto {
  @ApiProperty({ type: 'integer' })
  readonly inserted!: number;

  @ApiProperty({ type: 'integer', description: 'Ya existían en el modelo: se omitieron' })
  readonly skippedAlreadyPresent!: number;

  @ApiProperty({ type: 'object', additionalProperties: { type: 'integer' }, description: 'Filas en cuarentena por motivo' })
  readonly quarantined!: Record<string, number>;

  @ApiProperty({ type: 'integer' })
  readonly costCentersCreated!: number;
}

export class ImportJobEmailDto {
  @ApiProperty({
    enum: MAIL_OUTBOX_STATUSES,
    enumName: 'MailOutboxStatus',
    description: 'PENDING_SEND: en cola; SENT; FAILED: no salió (lastError dice por qué; sin SMTP queda así)',
  })
  readonly status!: (typeof MAIL_OUTBOX_STATUSES)[number];

  @ApiProperty({ type: 'integer' })
  readonly attempts!: number;

  @ApiProperty({ type: 'string', nullable: true })
  readonly lastError!: string | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly sentAt!: string | null;
}

export class ImportJobDto {
  @ApiProperty({ format: 'uuid', description: 'jobId: úselo para GET /imports/jobs/{jobId} y el reintento' })
  readonly id!: string;

  @ApiProperty({ format: 'uuid' })
  readonly importId!: string;

  @ApiProperty({ enum: IMPORT_TARGETS, enumName: 'ImportTarget' })
  readonly target!: (typeof IMPORT_TARGETS)[number];

  @ApiProperty({
    enum: IMPORT_JOB_STATUSES,
    enumName: 'ImportJobStatus',
    description: 'QUEUED → RUNNING → SUCCEEDED | FAILED. FAILED → (retry) → QUEUED',
  })
  readonly status!: (typeof IMPORT_JOB_STATUSES)[number];

  @ApiProperty({
    enum: IMPORT_JOB_PHASES,
    enumName: 'ImportJobPhase',
    description:
      'Dónde va (o dónde se detuvo si FAILED). QUEUED; ROWS: cuarentena e inserción; MOVEMENTS (solo ASSETS): movimientos de registro firmados; FINALIZING; DONE',
  })
  readonly phase!: (typeof IMPORT_JOB_PHASES)[number];

  @ApiProperty({ type: 'integer', description: 'Veces que un worker tomó el trabajo' })
  readonly attempts!: number;

  @ApiProperty({ type: ImportJobProgressDto })
  readonly progress!: ImportJobProgressDto;

  @ApiProperty({
    type: ImportJobRowsDto,
    nullable: true,
    description: 'Conteos de la fase de filas en cuanto se confirma (antes de los movimientos); null hasta entonces',
  })
  readonly rows!: ImportJobRowsDto | null;

  @ApiProperty({ type: ImportResultDto, nullable: true, description: 'Resultado final; solo con status=SUCCEEDED' })
  readonly result!: ImportResultDto | null;

  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'Motivo del fallo (solo FAILED). Nunca trae valores de las filas',
  })
  readonly error!: string | null;

  @ApiProperty({
    type: ImportJobEmailDto,
    nullable: true,
    description: 'Correo de aviso al terminar o fallar; null mientras no se ha encolado',
  })
  readonly email!: ImportJobEmailDto | null;

  @ApiProperty({ format: 'uuid', description: 'Usuario que confirmó; recibe el aviso' })
  readonly requestedBy!: string;

  @ApiProperty({ type: 'string', format: 'date-time' })
  readonly createdAt!: string;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true, description: 'Inicio del intento más reciente' })
  readonly startedAt!: string | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true, description: 'Último latido del worker' })
  readonly heartbeatAt!: string | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly finishedAt!: string | null;
}

/** `data` del envelope como arreglo de `dto` (envelopedSchema solo describe un objeto). */
export const envelopedJobListSchema = (): SchemaObject => ({
  allOf: [
    { $ref: getSchemaPath(ApiSuccessEnvelope) },
    { properties: { data: { type: 'array', items: { $ref: getSchemaPath(ImportJobDto) } } } },
  ],
});
