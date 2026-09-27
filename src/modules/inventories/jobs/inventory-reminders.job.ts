import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { FeatureFlagsService } from '../../features/services/feature-flags.service.js';
import { InventoryRemindersService } from '../services/inventory-reminders.service.js';

/**
 * Recordatorios de tomas físicas. Corre cada minuto: los recordatorios vencen a las 07:00 de Bogotá, así que salen
 * a más tardar un minuto después; con la cola vacía cada tic es una consulta sobre el índice parcial
 * idx_inventory_reminder_due. Dos instancias no envían el mismo recordatorio (FOR UPDATE SKIP LOCKED y el estado
 * final se escribe en la transacción que encola el correo). Solo con el módulo "inventories" encendido.
 * El correo encolado lo envía el worker del outbox (ImportJobsJob, cada 5 s).
 */
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
