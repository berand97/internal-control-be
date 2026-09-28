import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DataSource, type EntityManager, QueryFailedError } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AppConfig } from '../../../config/configuration.js';
import { MailOutboxService, type MailOutboxState } from '../../../shared/mail/mail-outbox.service.js';
import { NotificationsService } from '../../notifications/services/notifications.service.js';
import type { ImportTarget } from '../import/import-fields.js';
import { ISSUE_DESCRIPTIONS } from '../report/write-issues-csv.js';
import { ExcelImportService, type ImportResult, type ImportRowsResult } from './excel-import.service.js';

export const IMPORT_JOB_STATUSES = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED'] as const;
export type ImportJobStatus = (typeof IMPORT_JOB_STATUSES)[number];
export const IMPORT_JOB_PHASES = ['QUEUED', 'ROWS', 'MOVEMENTS', 'FINALIZING', 'DONE'] as const;
export type ImportJobPhase = (typeof IMPORT_JOB_PHASES)[number];

/**
 * Un trabajo RUNNING sin latido en este tiempo se considera abandonado (el proceso cayó) y otra instancia lo retoma.
 * El latido se renueva al terminar la fase de filas y en cada lote de movimientos (1.000 activos, ~0,1–0,5 s): 10
 * minutos deja margen amplio para una fase de filas grande sin que dos instancias trabajen a la vez.
 */
export const IMPORT_JOB_STALE_MINUTES = 10;
/** Tomas de un trabajo abandonado antes de darlo por FAILED (evita un ciclo si el trabajo tumba el proceso). */
export const IMPORT_JOB_MAX_ATTEMPTS = 3;

export const IMPORT_JOB_ENTITY = 'STAGING_IMPORT_JOB';

const TARGET_LABEL: Record<ImportTarget, string> = {
  ASSETS: 'activos',
  COST_CENTERS: 'centros de costo',
  PERSONS: 'personas',
};

interface JobRow {
  id: string;
  import_id: string;
  target: ImportTarget;
  status: ImportJobStatus;
  phase: ImportJobPhase;
  attempts: number;
  lease_id: string | null;
  heartbeat_at: Date | null;
  rows_result: ImportRowsResult | null;
  movements_total: number | null;
  movements_done: number;
  movements_seconds: number;
  result: ImportResult | null;
  last_error: string | null;
  requested_by: string;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

interface Claim {
  readonly id: string;
  readonly importId: string;
  readonly target: ImportTarget;
  readonly requestedBy: string;
  readonly lease: string;
  readonly rows: ImportRowsResult | null;
}

export interface ImportJobView {
  readonly id: string;
  readonly importId: string;
  readonly target: ImportTarget;
  readonly status: ImportJobStatus;
  readonly phase: ImportJobPhase;
  readonly attempts: number;
  readonly progress: {
    readonly movementsTotal: number | null;
    readonly movementsDone: number;
    readonly percent: number | null;
  };
  readonly rows: {
    readonly inserted: number;
    readonly skippedAlreadyPresent: number;
    readonly quarantined: Record<string, number>;
    readonly costCentersCreated: number;
  } | null;
  readonly result: ImportResult | null;
  readonly error: string | null;
  readonly email: MailOutboxState | null;
  readonly requestedBy: string;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly heartbeatAt: Date | null;
  readonly finishedAt: Date | null;
}

export type ImportJobOutcome = 'SUCCEEDED' | 'FAILED' | 'LEASE_LOST';

/** El arrendamiento del trabajo pasó a otra instancia (o el trabajo ya no está RUNNING): se abandona sin escribir. */
class LeaseLost extends Error {}

/** Texto del error que se guarda y se muestra: nunca valores de filas (pueden ser datos personales). */
const describeError = (error: unknown): string => {
  if (error instanceof QueryFailedError) {
    const driver = error.driverError as { code?: string; constraint?: string } | undefined;
    return `Error de base de datos (SQLSTATE ${driver?.code ?? 'desconocido'}${
      driver?.constraint ? `, restricción ${driver.constraint}` : ''
    })`;
  }
  if (error instanceof ApiException) {
    return error.message.slice(0, 500);
  }
  return error instanceof Error ? error.message.slice(0, 500) : 'Error desconocido';
};

const percentOf = (job: JobRow): number | null => {
  if (job.status === 'SUCCEEDED') {
    return 100;
  }
  if (job.phase === 'QUEUED') {
    return 0;
  }
  if (job.phase === 'MOVEMENTS' && job.movements_total) {
    return Math.min(99, Math.floor((job.movements_done * 100) / job.movements_total));
  }
  return null;
};

const quarantineLines = (quarantined: Record<string, number>): string[] =>
  Object.entries(quarantined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, count]) => `  - ${count} · ${ISSUE_DESCRIPTIONS[code] ? `${ISSUE_DESCRIPTIONS[code]} ` : ''}[${code}]`);

/**
 * Importación asíncrona sobre el patrón outbox del motor de documentos (document_request + job):
 * - enqueue (POST confirm) solo escribe staging_import_job y responde; nunca hace el trabajo en la petición.
 * - El worker (ImportJobsJob) toma trabajos con FOR UPDATE SKIP LOCKED y un arrendamiento (lease_id); cada
 *   transacción de trabajo empieza bloqueando la fila del trabajo con su lease, así otra instancia no puede tomarlo
 *   mientras tanto y una instancia que perdió el lease no escribe nada.
 * - Fases: ROWS (una transacción: cuarentena + inserción + rows_result del trabajo), MOVEMENTS (lotes de 1.000, cada
 *   uno su transacción con el avance), FINALIZING (una transacción: importación CONFIRMED, auditoría, trabajo
 *   SUCCEEDED, notificación en la app y correo encolado).
 * - Un fallo deja FAILED con la fase donde se detuvo; retry lo vuelve a la cola. Si la fase de filas ya se había
 *   confirmado no se repite (sus conteos quedaron en rows_result) y los movimientos solo se escriben para los activos
 *   que siguen sin ellos: reintentar no duplica activos ni movimientos.
 */
@Injectable()
export class ImportJobsService {
  private readonly logger = new Logger(ImportJobsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly imports: ExcelImportService,
    private readonly notifications: NotificationsService,
    private readonly outbox: MailOutboxService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /** Confirmar: encola (idempotente, un trabajo por importación) y devuelve el trabajo sin procesarlo. */
  async enqueue(importId: string, actorId: string): Promise<ImportJobView> {
    const [imported] = (await this.dataSource.query('SELECT id, target FROM staging_import WHERE id = $1', [
      importId,
    ])) as Array<{ id: string; target: ImportTarget }>;
    if (!imported) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'No existe la importación');
    }
    await this.dataSource.query(
      `INSERT INTO staging_import_job (import_id, target, requested_by) VALUES ($1, $2, $3)
       ON CONFLICT (import_id) DO NOTHING`,
      [importId, imported.target, actorId],
    );
    const job = await this.findByImport(importId);
    if (!job) {
      throw new Error('El trabajo de importación no quedó registrado');
    }
    return job;
  }

  async find(jobId: string): Promise<ImportJobView> {
    const [row] = (await this.dataSource.query('SELECT * FROM staging_import_job WHERE id = $1', [jobId])) as JobRow[];
    if (!row) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'No existe el trabajo de importación');
    }
    return this.view(row);
  }

  async findByImport(importId: string): Promise<ImportJobView | null> {
    const [row] = (await this.dataSource.query('SELECT * FROM staging_import_job WHERE import_id = $1', [
      importId,
    ])) as JobRow[];
    return row ? this.view(row) : null;
  }

  async listMine(userId: string, limit = 20): Promise<ReadonlyArray<ImportJobView>> {
    const rows = (await this.dataSource.query(
      'SELECT * FROM staging_import_job WHERE requested_by = $1 ORDER BY created_at DESC LIMIT $2',
      [userId, limit],
    )) as JobRow[];
    return Promise.all(rows.map((row) => this.view(row)));
  }

  /** Vuelve a la cola un trabajo FAILED. No repite lo que ya quedó escrito (ver la clase). */
  async retry(jobId: string): Promise<ImportJobView> {
    const [rows] = (await this.dataSource.query(
      `UPDATE staging_import_job SET status = 'QUEUED', phase = 'QUEUED', last_error = NULL, finished_at = NULL,
         lease_id = NULL, heartbeat_at = NULL
       WHERE id = $1 AND status = 'FAILED' RETURNING id`,
      [jobId],
    )) as [Array<{ id: string }>, number];
    if (rows.length === 0) {
      await this.find(jobId);
      throw new ApiException(ErrorCode.ImportJobNotRetryable);
    }
    return this.find(jobId);
  }

  /** Worker: toma y procesa hasta `limit` trabajos, uno tras otro. */
  async processPending(limit = 5): Promise<number> {
    await this.failAbandoned();
    let processed = 0;
    while (processed < limit) {
      const outcome = await this.processNext();
      if (!outcome) {
        break;
      }
      processed += 1;
    }
    return processed;
  }

  /** Toma el trabajo más antiguo disponible (o uno abandonado) y lo procesa. null si no hay nada que tomar. */
  async processNext(): Promise<ImportJobOutcome | null> {
    const claim = await this.claim(null);
    return claim ? this.run(claim) : null;
  }

  /** Procesa un trabajo concreto si está en cola (CLI y pruebas). null si otra instancia lo tiene o no está QUEUED. */
  async processJob(jobId: string): Promise<ImportJobOutcome | null> {
    const claim = await this.claim(jobId);
    return claim ? this.run(claim) : null;
  }

  /** Síncrono, para la CLI: encola, procesa y devuelve el resultado (o lanza con el error del trabajo). */
  async runNow(importId: string, actorId: string): Promise<ImportResult> {
    const job = await this.enqueue(importId, actorId);
    if (job.status === 'QUEUED') {
      await this.processJob(job.id);
    }
    const done = await this.find(job.id);
    if (done.status !== 'SUCCEEDED' || !done.result) {
      throw new Error(`La importación quedó ${done.status}: ${done.error ?? 'sin detalle'}`);
    }
    return done.result;
  }

  private async claim(jobId: string | null): Promise<Claim | null> {
    const lease = randomUUID();
    const [rows] = (await this.dataSource.query(
      `WITH next AS (
         SELECT id FROM staging_import_job
         WHERE ($1::uuid IS NULL OR id = $1)
           AND (status = 'QUEUED'
                OR ($1::uuid IS NULL AND status = 'RUNNING' AND attempts < $4
                    AND heartbeat_at < NOW() - make_interval(mins => $3)))
         ORDER BY created_at LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE staging_import_job j SET status = 'RUNNING', lease_id = $2, heartbeat_at = NOW(), started_at = NOW(),
         attempts = j.attempts + 1, finished_at = NULL, last_error = NULL,
         phase = CASE WHEN j.rows_result IS NULL THEN 'ROWS' WHEN j.target = 'ASSETS' THEN 'MOVEMENTS' ELSE 'FINALIZING' END
       FROM next WHERE j.id = next.id
       RETURNING j.id, j.import_id, j.target, j.requested_by, j.rows_result`,
      [jobId, lease, IMPORT_JOB_STALE_MINUTES, IMPORT_JOB_MAX_ATTEMPTS],
    )) as [
      Array<{ id: string; import_id: string; target: ImportTarget; requested_by: string; rows_result: ImportRowsResult | null }>,
      number,
    ];
    const row = rows[0];
    return row
      ? {
          id: row.id,
          importId: row.import_id,
          target: row.target,
          requestedBy: row.requested_by,
          lease,
          rows: row.rows_result,
        }
      : null;
  }

  /** Primera sentencia de cada transacción de trabajo: bloquea la fila del trabajo si el lease sigue siendo nuestro. */
  private async hold(manager: EntityManager, claim: Claim): Promise<void> {
    const [row] = (await manager.query(
      `SELECT id FROM staging_import_job WHERE id = $1 AND lease_id = $2 AND status = 'RUNNING' FOR UPDATE`,
      [claim.id, claim.lease],
    )) as Array<{ id: string }>;
    if (!row) {
      throw new LeaseLost();
    }
  }

  private async run(claim: Claim): Promise<ImportJobOutcome> {
    try {
      let rows = claim.rows;
      if (!rows) {
        rows = await this.dataSource.transaction(async (manager) => {
          await this.hold(manager, claim);
          const written = await this.imports.writeRows(manager, claim.importId, claim.requestedBy);
          await manager.query(
            `UPDATE staging_import_job SET rows_result = $2, movements_total = $3, phase = $4, heartbeat_at = NOW()
             WHERE id = $1`,
            [
              claim.id,
              JSON.stringify(written),
              claim.target === 'ASSETS' ? written.pendingMovements : null,
              claim.target === 'ASSETS' ? 'MOVEMENTS' : 'FINALIZING',
            ],
          );
          return written;
        });
      }
      let movementSeconds = 0;
      if (claim.target === 'ASSETS') {
        const start = process.hrtime.bigint();
        await this.imports.registerMovements(claim.importId, claim.requestedBy, {
          begin: (manager) => this.hold(manager, claim),
          done: async (manager, written) => {
            await manager.query(
              `UPDATE staging_import_job SET movements_done = movements_done + $2, heartbeat_at = NOW() WHERE id = $1`,
              [claim.id, written],
            );
          },
        });
        movementSeconds = Number(process.hrtime.bigint() - start) / 1e9;
        await this.dataSource.query(
          `UPDATE staging_import_job SET phase = 'FINALIZING', movements_seconds = movements_seconds + $3,
             heartbeat_at = NOW()
           WHERE id = $1 AND lease_id = $2`,
          [claim.id, claim.lease, movementSeconds],
        );
      }
      const finalRows = rows;
      await this.dataSource.transaction(async (manager) => {
        await this.hold(manager, claim);
        const [progress] = (await manager.query(
          'SELECT movements_done, movements_seconds FROM staging_import_job WHERE id = $1',
          [claim.id],
        )) as Array<{ movements_done: number; movements_seconds: number }>;
        const result: ImportResult = {
          inserted: finalRows.inserted,
          skippedAlreadyPresent: finalRows.skippedAlreadyPresent,
          quarantined: finalRows.quarantined,
          costCentersCreated: finalRows.costCentersCreated,
          registrationMovements: progress?.movements_done ?? 0,
          seconds: { rows: finalRows.seconds, movements: progress?.movements_seconds ?? 0 },
          costCenterStructure: finalRows.costCenterStructure ?? null,
        };
        await this.imports.markConfirmed(manager, claim.importId, claim.requestedBy, result);
        await manager.query(
          `UPDATE staging_import_job SET status = 'SUCCEEDED', phase = 'DONE', result = $2, finished_at = NOW(),
             lease_id = NULL, heartbeat_at = NOW()
           WHERE id = $1`,
          [claim.id, JSON.stringify(result)],
        );
        await this.notify(manager, claim, 'SUCCEEDED', result);
      });
      return 'SUCCEEDED';
    } catch (error) {
      if (error instanceof LeaseLost) {
        this.logger.warn(`Trabajo de importación ${claim.id}: el arrendamiento pasó a otra instancia; se abandona`);
        return 'LEASE_LOST';
      }
      const message = describeError(error);
      this.logger.error(`Trabajo de importación ${claim.id} falló: ${message}`);
      await this.fail(claim, message);
      return 'FAILED';
    }
  }

  private async fail(claim: Claim, message: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const [rows] = (await manager.query(
        `UPDATE staging_import_job SET status = 'FAILED', last_error = $3, finished_at = NOW(), lease_id = NULL
         WHERE id = $1 AND lease_id = $2 RETURNING id`,
        [claim.id, claim.lease, message],
      )) as [Array<{ id: string }>, number];
      if (rows.length > 0) {
        await this.notify(manager, claim, 'FAILED', null);
      }
    });
  }

  /** Trabajos RUNNING abandonados que agotaron sus tomas: FAILED con aviso, para que se vean y se reintenten a mano. */
  private async failAbandoned(): Promise<void> {
    const abandoned = (await this.dataSource.query(
      `SELECT id, import_id, target, requested_by, lease_id FROM staging_import_job
       WHERE status = 'RUNNING' AND attempts >= $1 AND heartbeat_at < NOW() - make_interval(mins => $2)`,
      [IMPORT_JOB_MAX_ATTEMPTS, IMPORT_JOB_STALE_MINUTES],
    )) as Array<{ id: string; import_id: string; target: ImportTarget; requested_by: string; lease_id: string }>;
    for (const job of abandoned) {
      await this.fail(
        { id: job.id, importId: job.import_id, target: job.target, requestedBy: job.requested_by, lease: job.lease_id, rows: null },
        `El trabajo se interrumpió ${IMPORT_JOB_MAX_ATTEMPTS} veces sin terminar (el proceso se detuvo)`,
      );
    }
  }

  /** Aviso en la app y correo encolado, en la transacción que deja el trabajo terminado o fallido. */
  private async notify(
    manager: EntityManager,
    claim: Claim,
    outcome: 'SUCCEEDED' | 'FAILED',
    result: ImportResult | null,
  ): Promise<void> {
    const [source] = (await manager.query(
      `SELECT b.file_name, i.sheet_name FROM staging_import i JOIN staging_batch b ON b.id = i.batch_id WHERE i.id = $1`,
      [claim.importId],
    )) as Array<{ file_name: string; sheet_name: string }>;
    const target = TARGET_LABEL[claim.target];
    const file = source ? `${source.file_name} · hoja ${source.sheet_name}` : '';
    const summary = result
      ? [
          `Insertados: ${result.inserted}`,
          `Omitidos por ya existir: ${result.skippedAlreadyPresent}`,
          `En cuarentena: ${Object.values(result.quarantined).reduce((total, count) => total + count, 0)}`,
          ...quarantineLines(result.quarantined),
          ...(result.costCentersCreated > 0 ? [`Centros de costo creados: ${result.costCentersCreated}`] : []),
          ...(result.costCenterStructure
            ? [
                `Estructura: ${result.costCenterStructure.parentChanges} cambios de padre, ${result.costCenterStructure.unitChanges} de unidad, ${result.costCenterStructure.movementChanges} de movimiento`,
                `Unidades creadas: ${result.costCenterStructure.unitsToCreate}; nombres distintos (no se cambiaron): ${result.costCenterStructure.nameDifferences}`,
              ]
            : []),
          ...(claim.target === 'ASSETS' ? [`Movimientos de registro: ${result.registrationMovements}`] : []),
        ].join('\n')
      : 'La importación se detuvo sin terminar. Puede reintentarla desde el asistente de importación sin volver a subir el archivo; lo que ya quedó escrito no se duplica.';
    const state = outcome === 'SUCCEEDED' ? 'terminada' : 'fallida';
    await this.notifications.create(manager, {
      recipientUserId: claim.requestedBy,
      type: outcome === 'SUCCEEDED' ? 'IMPORT_FINISHED' : 'IMPORT_FAILED',
      title: `Importación de ${target} ${state}`,
      body: `${file}\n${summary}`.trim(),
      entityType: IMPORT_JOB_ENTITY,
      entityId: claim.id,
    });
    await this.outbox.enqueue(manager, {
      templateType: 'IMPORT_FINISHED',
      recipientUserId: claim.requestedBy,
      context: {
        'importacion.estado': state,
        'importacion.destino': target,
        'importacion.archivo': file,
        'importacion.resumen': summary,
        'app.loginUrl': this.config.getOrThrow('appPublicUrl', { infer: true }),
        'app.name': 'Control Interno UNAC',
      },
      entityType: IMPORT_JOB_ENTITY,
      entityId: claim.id,
    });
  }

  private async view(job: JobRow): Promise<ImportJobView> {
    return {
      id: job.id,
      importId: job.import_id,
      target: job.target,
      status: job.status,
      phase: job.phase,
      attempts: job.attempts,
      progress: {
        movementsTotal: job.movements_total,
        movementsDone: job.movements_done,
        percent: percentOf(job),
      },
      rows: job.rows_result
        ? {
            inserted: job.rows_result.inserted,
            skippedAlreadyPresent: job.rows_result.skippedAlreadyPresent,
            quarantined: job.rows_result.quarantined,
            costCentersCreated: job.rows_result.costCentersCreated,
          }
        : null,
      result: job.result,
      error: job.last_error,
      email: await this.outbox.latestFor(IMPORT_JOB_ENTITY, job.id),
      requestedBy: job.requested_by,
      createdAt: job.created_at,
      startedAt: job.started_at,
      heartbeatAt: job.heartbeat_at,
      finishedAt: job.finished_at,
    };
  }
}
