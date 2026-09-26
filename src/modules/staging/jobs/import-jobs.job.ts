import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MailOutboxService } from '../../../shared/mail/mail-outbox.service.js';
import { FeatureFlagsService } from '../../features/services/feature-flags.service.js';
import { ImportJobsService } from '../services/import-jobs.service.js';

/**
 * Worker de importaciones y del outbox de correo. Corre cada 5 segundos (el de documentos corre cada minuto): quien
 * confirma una importación está mirando el asistente, y esperar hasta un minuto a que empiece sería peor que la
 * espera de antes. Con la cola vacía cada tic es una consulta sobre un índice parcial (status QUEUED/RUNNING), así
 * que el costo es despreciable. Dos instancias no toman el mismo trabajo: FOR UPDATE SKIP LOCKED + arrendamiento.
 * Dentro de una instancia, un tic no empieza si el anterior sigue corriendo (una importación grande dura más de 5 s).
 */
@Injectable()
export class ImportJobsJob {
  private readonly logger = new Logger(ImportJobsJob.name);
  private running = false;

  constructor(
    private readonly jobs: ImportJobsService,
    private readonly outbox: MailOutboxService,
    private readonly featureFlags: FeatureFlagsService,
  ) {}

  @Cron('*/5 * * * * *')
  async run(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      if (this.featureFlags.isEnabled('assets')) {
        await this.jobs.processPending();
      }
      // Correos de fin de importación (y cualquier otro del outbox): nunca dentro de una transacción.
      await this.outbox.dispatchPending();
    } catch (error) {
      this.logger.error('Falló el ciclo del worker de importaciones', error instanceof Error ? error.stack : String(error));
    } finally {
      this.running = false;
    }
  }
}
