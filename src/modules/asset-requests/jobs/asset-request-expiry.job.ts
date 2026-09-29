import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { FeatureFlagsService } from '../../features/services/feature-flags.service.js';
import { AssetRequestsService } from '../services/asset-requests.service.js';

/**
 * Vencimiento de solicitudes ACCEPTED sin resolución de Control Interno y RETURNED sin corrección del solicitante
 * (ASSET_REQUEST_EXPIRY_DAYS días desde la aceptación o la devolución). Cada 10 minutos; con la cola vacía es una consulta sobre el índice parcial idx_asset_request_expiry.
 * FOR UPDATE SKIP LOCKED y el aviso se encola en la transacción que vence la solicitud. Solo con el módulo «loans».
 */
@Injectable()
export class AssetRequestExpiryJob {
  private readonly logger = new Logger(AssetRequestExpiryJob.name);
  private running = false;

  constructor(
    private readonly requests: AssetRequestsService,
    private readonly featureFlags: FeatureFlagsService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async run(): Promise<void> {
    if (this.running || !this.featureFlags.isEnabled('loans')) {
      return;
    }
    this.running = true;
    try {
      await this.requests.expireDue();
    } catch (error) {
      this.logger.error('Falló el vencimiento de solicitudes de activos', error instanceof Error ? error.stack : String(error));
    } finally {
      this.running = false;
    }
  }
}
