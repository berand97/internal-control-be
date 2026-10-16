import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MailOutboxService } from '../../../shared/mail/mail-outbox.service.js';
import { FeatureFlagsService } from '../../features/services/feature-flags.service.js';
import { ImportJobsService } from '../services/import-jobs.service.js';

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
      await this.outbox.dispatchPending();
    } catch (error) {
      this.logger.error('Falló el ciclo del worker de importaciones', error instanceof Error ? error.stack : String(error));
    } finally {
      this.running = false;
    }
  }
}
