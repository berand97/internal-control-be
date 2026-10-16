import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { FeatureFlagsService } from '../../features/services/feature-flags.service.js';
import { InventoryRemindersService } from '../services/inventory-reminders.service.js';

@Injectable()
export class InventoryRemindersJob {
  private readonly logger = new Logger(InventoryRemindersJob.name);
  private running = false;

  constructor(
    private readonly reminders: InventoryRemindersService,
    private readonly featureFlags: FeatureFlagsService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async run(): Promise<void> {
    if (this.running || !this.featureFlags.isEnabled('inventories')) {
      return;
    }
    this.running = true;
    try {
      await this.reminders.processDue();
    } catch (error) {
      this.logger.error('Falló el ciclo de recordatorios de tomas', error instanceof Error ? error.stack : String(error));
    } finally {
      this.running = false;
    }
  }
}
