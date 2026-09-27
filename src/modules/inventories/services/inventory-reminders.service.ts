import { Injectable, Logger } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { bogotaDate, daysBetween, planReminders, type ReminderStatus } from '../domain/inventory-schedule.js';
import { InventoryScopeType } from '../enums/inventory-scope.js';
import { InventoryNoticesService, type NoticeInventory } from './inventory-notices.service.js';

export interface ReminderView {
  readonly id: string;
  readonly offsetDays: number;
  readonly dueAt: Date;
  readonly status: ReminderStatus;
  readonly sentAt: Date | null;
}

export type ReminderOutcome = Extract<ReminderStatus, 'SENT' | 'NO_RECIPIENT' | 'SKIPPED' | 'SUPERSEDED'>;

interface ClaimedRow {
  id: string;
  inventory_id: string;
  offset_days: number;
  schedule_rev: number;
}

interface InventoryRow {
  id: string;
  code: string;
  name: string;
  status: string;
  scope_type: InventoryScopeType;
  scope_id: string | null;
  start: string;
  end: string;
  responsible_user_id: string;
  reschedule_count: number;
}

const VIEW_COLUMNS = `id, offset_days AS "offsetDays", due_at AS "dueAt", status, sent_at AS "sentAt"`;

/**
 * Recordatorios de una toma (inventory_reminder). Al programar se crea uno por día de anticipación en la revisión
 * vigente (schedule_rev = reschedule_count); los que ya pasaron nacen SKIPPED. Reprogramar deja los PENDING
 * anteriores SUPERSEDED; cancelar los deja CANCELLED.
 *
 * Envío (processDue, llamado por InventoryRemindersJob): cada recordatorio se reclama con FOR UPDATE SKIP LOCKED y,
 * en la MISMA transacción, se encolan correo + notificación y se marca el estado final (SENT, NO_RECIPIENT si no hay
 * jefe con correo, SKIPPED o SUPERSEDED). Un reinicio o un segundo worker no reenvían: o la transacción confirmó
 * todo, o nada. El correo sale luego por el worker del outbox (fuera de transacción).
 */
@Injectable()
export class InventoryRemindersService {
  private readonly logger = new Logger(InventoryRemindersService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly notices: InventoryNoticesService,
  ) {}

  async plan(
    manager: EntityManager,
    inventoryId: string,
    plannedStartDate: string,
    offsets: ReadonlyArray<number>,
    scheduleRev: number,
    now: Date = new Date(),
  ): Promise<ReminderView[]> {
    for (const reminder of planReminders(plannedStartDate, offsets, now)) {
      await manager.query(
        `INSERT INTO inventory_reminder (inventory_id, offset_days, due_at, schedule_rev, status, processed_at)
         VALUES ($1, $2, $3, $4, $5::text, CASE WHEN $5::text = 'SKIPPED' THEN NOW() END)`,
        [inventoryId, reminder.offsetDays, reminder.dueAt, scheduleRev, reminder.status],
      );
    }
    return this.current(manager, inventoryId, scheduleRev);
  }

  /** Reprogramar: los pendientes de revisiones anteriores ya no se envían. */
  async supersede(manager: EntityManager, inventoryId: string): Promise<void> {
    await manager.query(
      `UPDATE inventory_reminder SET status = 'SUPERSEDED', processed_at = NOW()
       WHERE inventory_id = $1 AND status = 'PENDING'`,
      [inventoryId],
    );
  }

  /** Cancelar la toma: ningún pendiente se envía. */
  async cancelPending(manager: EntityManager, inventoryId: string): Promise<void> {
    await manager.query(
      `UPDATE inventory_reminder SET status = 'CANCELLED', processed_at = NOW()
       WHERE inventory_id = $1 AND status = 'PENDING'`,
      [inventoryId],
    );
  }

  async current(manager: EntityManager | null, inventoryId: string, scheduleRev: number): Promise<ReminderView[]> {
    return (await (manager ?? this.dataSource).query(
      `SELECT ${VIEW_COLUMNS} FROM inventory_reminder
       WHERE inventory_id = $1 AND schedule_rev = $2 ORDER BY offset_days DESC`,
      [inventoryId, scheduleRev],
    )) as ReminderView[];
  }

  /** Procesa hasta `limit` recordatorios vencidos, uno por transacción. */
  async processDue(limit = 50): Promise<Record<ReminderOutcome, number>> {
    const totals: Record<ReminderOutcome, number> = { SENT: 0, NO_RECIPIENT: 0, SKIPPED: 0, SUPERSEDED: 0 };
    for (let index = 0; index < limit; index += 1) {
      const outcome = await this.processOne();
      if (outcome === null) {
        break;
      }
      totals[outcome] += 1;
    }
    return totals;
  }

  /** Un recordatorio vencido: reclamo, aviso y estado final en una sola transacción. null si no hay ninguno libre. */
  async processOne(now: Date = new Date()): Promise<ReminderOutcome | null> {
    return this.dataSource.transaction(async (manager) => {
      const [claimed] = (await manager.query(
        `SELECT id, inventory_id, offset_days, schedule_rev FROM inventory_reminder
         WHERE status = 'PENDING' AND due_at <= $1
         ORDER BY due_at, id
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [now],
      )) as ClaimedRow[];
      if (!claimed) {
        return null;
      }
      const [inventory] = (await manager.query(
        `SELECT id, code, name, status, scope_type, scope_id, responsible_user_id, reschedule_count,
                to_char(scheduled_start_date, 'YYYY-MM-DD') AS start, to_char(scheduled_end_date, 'YYYY-MM-DD') AS end
         FROM physical_inventory WHERE id = $1`,
        [claimed.inventory_id],
      )) as InventoryRow[];
      const decision = await this.decide(manager, claimed, inventory, now);
      if (decision !== 'SEND') {
        await this.finish(manager, claimed.id, decision, []);
        return decision;
      }
      const subject: NoticeInventory = {
        id: inventory?.id ?? '',
        code: inventory?.code ?? '',
        name: inventory?.name ?? '',
        scopeType: inventory?.scope_type ?? InventoryScopeType.Global,
        scopeId: inventory?.scope_id ?? null,
        plannedStartDate: inventory?.start ?? '',
        plannedEndDate: inventory?.end ?? '',
        responsibleUserId: inventory?.responsible_user_id ?? '',
      };
      const sent = await this.notices.send(manager, subject, 'REMINDER', {
        daysUntilStart: daysBetween(bogotaDate(now), subject.plannedStartDate),
      });
      const status: ReminderOutcome = sent.outboxIds.length > 0 ? 'SENT' : 'NO_RECIPIENT';
      await this.finish(manager, claimed.id, status, sent.outboxIds);
      if (status === 'NO_RECIPIENT') {
        this.logger.warn(`Recordatorio ${claimed.id} de la toma ${subject.code} sin jefe con correo`);
      }
      return status;
    });
  }

  private async decide(
    manager: EntityManager,
    claimed: ClaimedRow,
    inventory: InventoryRow | undefined,
    now: Date,
  ): Promise<'SEND' | 'SKIPPED' | 'SUPERSEDED'> {
    if (!inventory || inventory.status !== 'PLANNED' || inventory.start < bogotaDate(now)) {
      // La toma ya empezó, terminó, se canceló o su inicio pasó sin iniciarla: el recordatorio ya no aplica.
      return 'SKIPPED';
    }
    if (Number(inventory.reschedule_count) !== Number(claimed.schedule_rev)) {
      return 'SUPERSEDED';
    }
    // Si el worker estuvo detenido y ya venció también un recordatorio más cercano al inicio, solo se envía ese.
    const [closer] = (await manager.query(
      `SELECT 1 FROM inventory_reminder
       WHERE inventory_id = $1 AND schedule_rev = $2 AND status = 'PENDING'
         AND offset_days < $3 AND due_at <= $4`,
      [claimed.inventory_id, claimed.schedule_rev, claimed.offset_days, now],
    )) as unknown[];
    return closer ? 'SKIPPED' : 'SEND';
  }

  private async finish(
    manager: EntityManager,
    id: string,
    status: ReminderOutcome,
    outboxIds: ReadonlyArray<string>,
  ): Promise<void> {
    await manager.query(
      `UPDATE inventory_reminder
       SET status = $2::text, processed_at = NOW(), outbox_ids = $3::uuid[],
           sent_at = CASE WHEN $2::text = 'SENT' THEN NOW() END
       WHERE id = $1`,
      [id, status, outboxIds],
    );
  }
}
