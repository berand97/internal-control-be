import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import { UserStatus } from '../../auth/enums/user-status.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import { AppUser } from '../../auth/entities/app-user.entity.js';
import { assertInventoryTransition } from '../domain/inventory-transitions.js';
import { DEFAULT_REMINDER_OFFSETS_DAYS, bogotaDate } from '../domain/inventory-schedule.js';
import type { CancelInventoryDto, CreateInventoryDto, RescheduleInventoryDto } from '../dto/inventory.dto.js';
import { PhysicalInventory } from '../entities/physical-inventory.entity.js';
import { PhysicalInventoryScope } from '../entities/physical-inventory-scope.entity.js';
import { InventoryScopeType } from '../enums/inventory-scope.js';
import { InventoryStatus } from '../enums/inventory-status.js';
import { InventoriesService } from './inventories.service.js';
import { InventoryConflictsService, type InventoryConflict } from './inventory-conflicts.service.js';
import {
  INVENTORY_ENTITY_TYPE,
  InventoryNoticesService,
  type NoticeRecipientView,
  type NoticeWarning,
} from './inventory-notices.service.js';
import { InventoryRemindersService, type ReminderView } from './inventory-reminders.service.js';
import { inventorySummary, loadResponsibleNames, type InventorySummary } from './inventory-summary.js';

export type InventoryScheduleResult = InventorySummary & {
  readonly reminders: ReadonlyArray<ReminderView>;
  readonly noticeRecipients: ReadonlyArray<NoticeRecipientView>;
  readonly warnings: ReadonlyArray<NoticeWarning>;
  readonly conflicts: ReadonlyArray<InventoryConflict>;
};

export type InventoryCancelResult = InventorySummary & {
  readonly noticeRecipients: ReadonlyArray<NoticeRecipientView>;
  readonly warnings: ReadonlyArray<NoticeWarning>;
};

const day = (value: string): string => value.slice(0, 10);

/**
 * Programar, reprogramar y cancelar tomas físicas. La toma programada es la misma physical_inventory (nace PLANNED y
 * start() la inicia). Cada operación es una transacción: la toma, sus recordatorios, el aviso (correo en el outbox +
 * notificación) y la auditoría se confirman juntos o nada. Los choques de fechas con otras tomas solo advierten.
 */
@Injectable()
export class InventorySchedulesService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly inventories: InventoriesService,
    private readonly conflicts: InventoryConflictsService,
    private readonly notices: InventoryNoticesService,
    private readonly reminders: InventoryRemindersService,
    @Inject('AuditLogsRepository')
    private readonly auditLogs: AuditLogsRepository,
  ) {}

  async schedule(dto: CreateInventoryDto, actor: AuthenticatedUser): Promise<InventoryScheduleResult> {
    this.inventories.assertScope(dto.scope, dto.scopeId);
    await this.inventories.requireScopeTarget(dto.scope, dto.scopeId ?? null);
    const start = day(dto.plannedStartDate);
    const end = day(dto.plannedEndDate);
    this.assertRange(start, end);
    const offsets = [...(dto.reminderOffsetsDays ?? DEFAULT_REMINDER_OFFSETS_DAYS)].sort((left, right) => right - left);
    const now = new Date();
    return this.dataSource.transaction(async (manager) => {
      await this.requireActiveUser(manager, dto.responsibleUserId);
      const code = await this.inventories.nextCode(manager);
      const repository = manager.getRepository(PhysicalInventory);
      const inventory = await repository.save(
        repository.create({
          code,
          name: dto.name,
          plannedStartDate: start,
          plannedEndDate: end,
          actualStartDate: null,
          actualEndDate: null,
          status: InventoryStatus.Planned,
          responsibleUserId: dto.responsibleUserId,
          scopeType: dto.scope,
          scopeId: dto.scopeId ?? null,
          scopeNotes: dto.notes ?? null,
          closedAt: null,
          closedBy: null,
          reconcileRequestedAt: null,
          reconcileRequestedBy: null,
          reconcileApprovedAt: null,
          reconcileApprovedBy: null,
          discrepancyReport: null,
          rescheduleCount: 0,
          rescheduledAt: null,
          reminderOffsetsDays: offsets,
          cancelReason: null,
          cancelledAt: null,
          cancelledBy: null,
          createdAt: now,
          createdBy: actor.id,
        }),
      );
      if (dto.scope === InventoryScopeType.CostCenter && dto.scopeId) {
        await manager.getRepository(PhysicalInventoryScope).save({ inventoryId: inventory.id, costCenterId: dto.scopeId });
      }
      const reminders = await this.reminders.plan(manager, inventory.id, start, offsets, 0, now);
      const conflicts = await this.conflicts.conflictsOf(this.subject(inventory), manager);
      const notice = await this.notices.send(manager, this.subject(inventory), 'SCHEDULED');
      const warnings = [
        ...notice.audience.warnings,
        ...this.scheduleWarnings(start, reminders, conflicts, now),
      ];
      await this.auditLogs.record(
        {
          action: AuditAction.InventoryCreated,
          entityType: INVENTORY_ENTITY_TYPE,
          entityId: inventory.id,
          performedBy: actor.id,
          ipAddress: null,
          userAgent: null,
          changes: {
            code,
            scope: dto.scope,
            scopeId: dto.scopeId ?? null,
            plannedStartDate: start,
            plannedEndDate: end,
            reminderOffsetsDays: offsets,
            ...this.noticeAudit(notice.audience.recipients, notice.outboxIds.length, warnings),
          },
        },
        manager,
      );
      return {
        ...inventorySummary(inventory, await loadResponsibleNames(manager, [inventory.responsibleUserId])),
        reminders,
        noticeRecipients: notice.audience.recipients,
        warnings,
        conflicts,
      };
    });
  }

  async reschedule(id: string, dto: RescheduleInventoryDto, actor: AuthenticatedUser): Promise<InventoryScheduleResult> {
    const start = day(dto.plannedStartDate);
    const end = day(dto.plannedEndDate);
    this.assertRange(start, end);
    const now = new Date();
    if (start < bogotaDate(now)) {
      throw new ApiException(ErrorCode.ValidationFailed, 'La nueva fecha de inicio no puede ser anterior a hoy', [
        { field: 'plannedStartDate', message: 'Debe ser hoy o una fecha futura' },
      ]);
    }
    return this.dataSource.transaction(async (manager) => {
      const inventory = await this.lockPlanned(manager, id);
      if (inventory.plannedStartDate === start && inventory.plannedEndDate === end) {
        throw new ApiException(ErrorCode.ValidationFailed, 'Las fechas nuevas son iguales a las actuales', [
          { field: 'plannedStartDate', message: 'Reprogramar exige cambiar al menos una fecha' },
        ]);
      }
      const previous = { start: inventory.plannedStartDate, end: inventory.plannedEndDate };
      const offsets = [...(dto.reminderOffsetsDays ?? inventory.reminderOffsetsDays)].sort((left, right) => right - left);
      inventory.plannedStartDate = start;
      inventory.plannedEndDate = end;
      inventory.rescheduleCount += 1;
      inventory.rescheduledAt = now;
      inventory.reminderOffsetsDays = offsets;
      await manager.getRepository(PhysicalInventory).save(inventory);
      await this.reminders.supersede(manager, inventory.id);
      const reminders = await this.reminders.plan(manager, inventory.id, start, offsets, inventory.rescheduleCount, now);
      const conflicts = await this.conflicts.conflictsOf(this.subject(inventory), manager);
      const notice = await this.notices.send(manager, this.subject(inventory), 'RESCHEDULED', {
        reason: dto.reason,
        previousStartDate: previous.start,
        previousEndDate: previous.end,
      });
      const warnings = [...notice.audience.warnings, ...this.scheduleWarnings(start, reminders, conflicts, now)];
      await this.auditLogs.record(
        {
          action: AuditAction.InventoryRescheduled,
          entityType: INVENTORY_ENTITY_TYPE,
          entityId: inventory.id,
          performedBy: actor.id,
          ipAddress: null,
          userAgent: null,
          changes: {
            plannedStartDate: { old: previous.start, new: start },
            plannedEndDate: { old: previous.end, new: end },
            reminderOffsetsDays: offsets,
            rescheduleCount: inventory.rescheduleCount,
            reason: dto.reason,
            ...this.noticeAudit(notice.audience.recipients, notice.outboxIds.length, warnings),
          },
        },
        manager,
      );
      return {
        ...inventorySummary(inventory, await loadResponsibleNames(manager, [inventory.responsibleUserId])),
        reminders,
        noticeRecipients: notice.audience.recipients,
        warnings,
        conflicts,
      };
    });
  }

  async cancel(id: string, dto: CancelInventoryDto, actor: AuthenticatedUser): Promise<InventoryCancelResult> {
    return this.dataSource.transaction(async (manager) => {
      const inventory = await this.lockPlanned(manager, id);
      assertInventoryTransition(inventory.status, InventoryStatus.Cancelled);
      const now = new Date();
      inventory.status = InventoryStatus.Cancelled;
      inventory.cancelReason = dto.reason;
      inventory.cancelledAt = now;
      inventory.cancelledBy = actor.id;
      await manager.getRepository(PhysicalInventory).save(inventory);
      await this.reminders.cancelPending(manager, inventory.id);
      const notice = await this.notices.send(manager, this.subject(inventory), 'CANCELLED', { reason: dto.reason });
      await this.auditLogs.record(
        {
          action: AuditAction.InventoryCancelled,
          entityType: INVENTORY_ENTITY_TYPE,
          entityId: inventory.id,
          performedBy: actor.id,
          ipAddress: null,
          userAgent: null,
          changes: {
            status: { old: InventoryStatus.Planned, new: InventoryStatus.Cancelled },
            reason: dto.reason,
            ...this.noticeAudit(notice.audience.recipients, notice.outboxIds.length, notice.audience.warnings),
          },
        },
        manager,
      );
      return {
        ...inventorySummary(inventory, await loadResponsibleNames(manager, [inventory.responsibleUserId])),
        noticeRecipients: notice.audience.recipients,
        warnings: notice.audience.warnings,
      };
    });
  }

  /** Recordatorios de la revisión vigente (para el detalle). */
  async remindersOf(id: string): Promise<ReminderView[]> {
    const inventory = await this.dataSource.getRepository(PhysicalInventory).findOne({ where: { id } });
    if (!inventory) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return this.reminders.current(null, inventory.id, inventory.rescheduleCount);
  }

  private assertRange(start: string, end: string): void {
    if (end < start) {
      throw new ApiException(ErrorCode.ValidationFailed, 'La fecha de fin no puede ser anterior a la de inicio', [
        { field: 'plannedEndDate', message: 'Debe ser igual o posterior a plannedStartDate' },
      ]);
    }
  }

  private async requireActiveUser(manager: EntityManager, userId: string): Promise<void> {
    const user = await manager.getRepository(AppUser).findOne({ where: { id: userId, status: UserStatus.Active } });
    if (!user) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
  }

  /** Bloquea la fila: dos reprogramaciones o una reprogramación y una cancelación no se cruzan. Solo PLANNED. */
  private async lockPlanned(manager: EntityManager, id: string): Promise<PhysicalInventory> {
    const inventory = await manager
      .getRepository(PhysicalInventory)
      .createQueryBuilder('i')
      .setLock('pessimistic_write')
      .where('i.id = :id', { id })
      .getOne();
    if (!inventory) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    if (inventory.status !== InventoryStatus.Planned) {
      throw new ApiException(ErrorCode.InvalidState, 'Solo se puede reprogramar o cancelar una toma planeada');
    }
    return inventory;
  }

  private subject(inventory: PhysicalInventory) {
    return {
      id: inventory.id,
      code: inventory.code,
      name: inventory.name,
      scopeType: inventory.scopeType,
      scopeId: inventory.scopeId,
      plannedStartDate: inventory.plannedStartDate,
      plannedEndDate: inventory.plannedEndDate,
      responsibleUserId: inventory.responsibleUserId,
    };
  }

  private scheduleWarnings(
    start: string,
    reminders: ReadonlyArray<ReminderView>,
    conflicts: ReadonlyArray<InventoryConflict>,
    now: Date,
  ): NoticeWarning[] {
    const warnings: NoticeWarning[] = [];
    if (conflicts.length > 0) {
      warnings.push({
        code: 'SCHEDULE_OVERLAP',
        message: `Las fechas se cruzan con ${conflicts.length === 1 ? 'la toma' : 'las tomas'} ${conflicts
          .map((item) => item.code)
          .join(', ')} del mismo alcance o con activos en común`,
      });
    }
    const skipped = reminders.filter((item) => item.status === 'SKIPPED').map((item) => item.offsetDays);
    if (skipped.length > 0) {
      warnings.push({
        code: 'REMINDERS_SKIPPED',
        message: `Los recordatorios de ${skipped.join(', ')} ${skipped.length === 1 && skipped[0] === 1 ? 'día' : 'días'} antes ya pasaron y no se enviarán`,
      });
    }
    if (start < bogotaDate(now)) {
      warnings.push({ code: 'START_IN_PAST', message: 'La fecha de inicio ya pasó' });
    }
    return warnings;
  }

  /** Para auditoría: cuántos y con qué rol, nunca correos ni nombres. */
  private noticeAudit(
    recipients: ReadonlyArray<NoticeRecipientView>,
    emails: number,
    warnings: ReadonlyArray<NoticeWarning>,
  ): Record<string, unknown> {
    return {
      notice: {
        emailsQueued: emails,
        inAppRecipients: recipients.filter((item) => item.inApp).length,
        headPersonIds: recipients.filter((item) => item.role === 'COST_CENTER_HEAD').map((item) => item.personId),
        warnings: warnings.map((item) => item.code),
      },
    };
  }
}
