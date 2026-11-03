import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { FeatureFlagsService } from '../../features/services/feature-flags.service.js';
import { ASSET_PHOTO_LIMITS, AssetPhotosService } from '../services/asset-photos.service.js';

@Injectable()
export class AssetPhotoStagedCleanupJob {
  private readonly logger = new Logger(AssetPhotoStagedCleanupJob.name);
  private running = false;

  constructor(
    private readonly photos: AssetPhotosService,
    private readonly featureFlags: FeatureFlagsService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM, { timeZone: 'America/Bogota' })
  async run(): Promise<number> {
    if (this.running || !this.featureFlags.isEnabled('assets')) {
      return 0;
    }
    this.running = true;
    try {
      const removed = await this.photos.purgeStaged(
        new Date(Date.now() - ASSET_PHOTO_LIMITS.stagedTtlHours * 3_600_000),
      );
      if (removed > 0) {
        this.logger.log(`Fotos pendientes borradas: ${removed}`);
      }
      return removed;
    } catch (error) {
      this.logger.error('Falló la limpieza de fotos pendientes', error instanceof Error ? error.stack : String(error));
      return 0;
    } finally {
      this.running = false;
    }
  }
}
