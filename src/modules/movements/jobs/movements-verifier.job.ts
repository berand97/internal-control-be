import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { FeatureFlagsService } from '../../features/services/feature-flags.service.js';
import { MovementsService } from '../services/movements.service.js';

@Injectable()
export class MovementsVerifierJob {
  constructor(
    private readonly movementsService: MovementsService,
    private readonly featureFlags: FeatureFlagsService,
  ) {}

  @Cron('0 6 * * *')
  async runDaily(): Promise<void> {
    if (!this.featureFlags.isEnabled('movements')) {
      return;
    }
    await this.movementsService.verifySample(100);
  }
}
