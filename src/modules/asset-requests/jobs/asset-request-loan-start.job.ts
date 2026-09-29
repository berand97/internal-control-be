import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { FeatureFlagsService } from '../../features/services/feature-flags.service.js';
import { AssetRequestsService } from '../services/asset-requests.service.js';

/**
 * Aviso diario del día de inicio de los préstamos programados por una solicitud de activos (LOAN_SCHEDULED): «hoy se
 * entrega» al solicitante y a los jefes del centro dueño, una sola vez por préstamo (AssetRequestsService
 * .noticeLoanStarts, idempotente por el evento LOAN_START_NOTICE). No entrega nada: la entrega es una acción explícita
 * (POST /loans/:id/deliver). Misma hora y bandera que el marcado de vencidos (loans-overdue.job.ts).
 */
@Injectable()
export class AssetRequestLoanStartJob {
  private readonly logger = new Logger(AssetRequestLoanStartJob.name);
  private running = false;

  constructor(
    private readonly requests: AssetRequestsService,
    private readonly featureFlags: FeatureFlagsService,
  ) {}

  @Cron('0 7 * * *')
  async runDaily(): Promise<void> {
    if (this.running || !this.featureFlags.isEnabled('loans')) {
      return;
    }
    this.running = true;
    try {
      await this.requests.noticeLoanStarts();
    } catch (error) {
      this.logger.error('Falló el aviso del día de inicio de los préstamos programados', error instanceof Error ? error.stack : String(error));
    } finally {
      this.running = false;
    }
  }
}
