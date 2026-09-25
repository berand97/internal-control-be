import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { FeatureFlagsService } from '../../features/services/feature-flags.service.js';
import { DocumentEngineService } from '../services/document-engine.service.js';

@Injectable()
export class DocumentRequestsJob {
  constructor(
    private readonly engine: DocumentEngineService,
    private readonly featureFlags: FeatureFlagsService,
  ) {}

  @Cron('*/1 * * * *')
  async run(): Promise<void> {
    if (!this.featureFlags.isEnabled('document-templates')) {
      return;
    }
    await this.engine.processPending();
    // Actas con todas sus firmas cuyo proceso falló al aplicar sus efectos: reintentar la transición.
    await this.engine.retryLifecycle();
  }
}
