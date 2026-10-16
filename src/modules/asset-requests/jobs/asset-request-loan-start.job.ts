import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { FeatureFlagsService } from '../../features/services/feature-flags.service.js';
import { AssetRequestsService } from '../services/asset-requests.service.js';

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
