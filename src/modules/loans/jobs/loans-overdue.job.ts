import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { FeatureFlagsService } from '../../features/services/feature-flags.service.js';
import { LoansService } from '../services/loans.service.js';

@Injectable()
export class LoansOverdueCheckerJob {
  constructor(
    private readonly loansService: LoansService,
    private readonly featureFlags: FeatureFlagsService,
  ) {}

  @Cron('0 7 * * *')
  async runDaily(): Promise<void> {
    if (!this.featureFlags.isEnabled('loans')) {
      return;
    }
    await this.loansService.markOverdue();
  }
}
