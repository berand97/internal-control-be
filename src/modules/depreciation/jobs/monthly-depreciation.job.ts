import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { FeatureFlagsService } from '../../features/services/feature-flags.service.js';
import { DepreciationService } from '../services/depreciation.service.js';

@Injectable()
export class MonthlyDepreciationJob {
  constructor(
    private readonly depreciationService: DepreciationService,
    private readonly featureFlags: FeatureFlagsService,
  ) {}

  @Cron('0 2 1 * *')
  async runMonthly(): Promise<void> {
    if (!this.featureFlags.isEnabled('depreciation')) {
      return;
    }
    await this.depreciationService.calculatePreviousMonth();
  }
}
