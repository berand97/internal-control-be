import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { FeatureFlagsService } from '../../features/services/feature-flags.service.js';
import { DocumentEngineService } from '../services/document-engine.service.js';
import { SigningLinkService } from '../services/signing-link.service.js';

@Injectable()
export class DocumentRequestsJob {
  constructor(
    private readonly engine: DocumentEngineService,
    private readonly featureFlags: FeatureFlagsService,
    private readonly links: SigningLinkService,
  ) {}

  @Cron('*/1 * * * *')
  async run(): Promise<void> {
    if (!this.featureFlags.isEnabled('document-templates')) {
      return;
    }
    await this.engine.processPending();
    await this.engine.retryLifecycle();
    await this.engine.retrySignedPdfs();
    await this.links.dispatchPending();
  }
}
