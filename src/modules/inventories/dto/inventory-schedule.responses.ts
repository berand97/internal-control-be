import { ApiProperty } from '@nestjs/swagger';
import { REMINDER_STATUSES } from '../domain/inventory-schedule.js';
import { INVENTORY_SCOPE_TYPES, InventoryScopeType } from '../enums/inventory-scope.js';
import { INVENTORY_STATUSES, InventoryStatus } from '../enums/inventory-status.js';

/**
 * Esquemas de respuesta de la programación de tomas (POST /inventories, /:id/reschedule, /:id/cancel,
 * GET /inventories/calendar y /inventories/coverage). Solo documentan lo que devuelven InventorySchedulesService e
 * InventoryPlanningService: cambiar un shape exige cambiar ambos.
 */

export const INVENTORY_SCHEDULE_WARNING_CODES = [
  'NO_HEAD_WITH_EMAIL',
  'NO_HEAD_FOR_SCOPE',
  'SCHEDULE_OVERLAP',
  'REMINDERS_SKIPPED',
  'START_IN_PAST',
] as const;
export type InventoryScheduleWarningCode = (typeof INVENTORY_SCHEDULE_WARNING_CODES)[number];

export const INVENTORY_NOTICE_ROLES = ['COST_CENTER_HEAD', 'RESPONSIBLE'] as const;
export type InventoryNoticeRole = (typeof INVENTORY_NOTICE_ROLES)[number];

export const INVENTORY_CONFLICT_REASONS = ['SAME_SCOPE', 'GLOBAL_SCOPE', 'SHARED_ASSETS'] as const;
export type InventoryConflictReason = (typeof INVENTORY_CONFLICT_REASONS)[number];

export const INVENTORY_COVERAGE_CLOSED_STATUSES = [InventoryStatus.Closed, InventoryStatus.Reconciled] as const;

const WARNING_DESCRIPTION =
  'NO_HEAD_WITH_EMAIL: el centro no tiene jefe vigente con correo (nadie recibe el correo); NO_HEAD_FOR_SCOPE: el ' +
  'alcance no es un centro de costo, así que no hay jefe a quien avisar; SCHEDULE_OVERLAP: otra toma planeada o en ' +
  'curso del mismo alcance o con activos compartidos cruza fechas (ver conflicts); REMINDERS_SKIPPED: algunos ' +
  'recordatorios ya pasaron y no se enviarán; START_IN_PAST: la fecha de inicio ya pasó';

// ---------- Resumen de la toma (común) ----------

export class InventoryResponsibleDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ description: 'Nombres y apellidos de la persona del usuario; si no tiene persona, su usuario' })
  readonly name!: string;
}

export class InventorySummaryDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ example: 'TF-2026-014' })
  readonly code!: string;

  @ApiProperty()
  readonly name!: string;

  @ApiProperty({ enum: INVENTORY_STATUSES, enumName: 'InventoryStatus' })
  readonly status!: InventoryStatus;

  @ApiProperty({ enum: INVENTORY_SCOPE_TYPES, enumName: 'InventoryScopeType' })
  readonly scope!: InventoryScopeType;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, description: 'null en alcance GLOBAL' })
  readonly scopeId!: string | null;

  @ApiProperty({ format: 'date' })
  readonly plannedStartDate!: string;

  @ApiProperty({ format: 'date' })
  readonly plannedEndDate!: string;

  @ApiProperty({ type: 'string', format: 'date', nullable: true })
  readonly actualStartDate!: string | null;

  @ApiProperty({ type: 'string', format: 'date', nullable: true })
  readonly actualEndDate!: string | null;

  @ApiProperty({ format: 'uuid' })
  readonly responsibleUserId!: string;

  @ApiProperty({
    type: InventoryResponsibleDto,
    description: 'Responsable de la toma con su nombre (no exige user:read:global para mostrarlo)',
  })
  readonly responsible!: InventoryResponsibleDto;

  @ApiProperty({ type: 'string', nullable: true })
  readonly notes!: string | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly closedAt!: string | null;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true })
  readonly closedBy!: string | null;

  @ApiProperty({ type: 'string', nullable: true, description: 'Nombre de quien cerró la toma (persona o, sin persona, usuario)' })
  readonly closedByName!: string | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly reconcileRequestedAt!: string | null;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true })
  readonly reconcileRequestedBy!: string | null;

  @ApiProperty({ type: 'string', nullable: true, description: 'Nombre de quien solicitó la conciliación' })
  readonly reconcileRequestedByName!: string | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly reconcileApprovedAt!: string | null;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true })
  readonly reconcileApprovedBy!: string | null;

  @ApiProperty({ type: 'string', nullable: true, description: 'Nombre de quien aprobó la conciliación' })
  readonly reconcileApprovedByName!: string | null;

  @ApiProperty({ description: 'Derivado: rescheduleCount > 0 ("reprogramada" no es un estado)' })
  readonly rescheduled!: boolean;

  @ApiProperty({ type: 'integer', minimum: 0 })
  readonly rescheduleCount!: number;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly rescheduledAt!: string | null;

  @ApiProperty({ type: [Number], description: 'Días antes del inicio con recordatorio; [] en tomas sin recordatorios' })
  readonly reminderOffsetsDays!: number[];

  @ApiProperty({ type: 'string', nullable: true })
  readonly cancelReason!: string | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly cancelledAt!: string | null;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true })
  readonly cancelledBy!: string | null;

  @ApiProperty({ type: 'string', nullable: true, description: 'Nombre de quien canceló la toma (persona o, sin persona, usuario)' })
  readonly cancelledByName!: string | null;

  @ApiProperty({
    type: 'string',
    format: 'uuid',
    nullable: true,
    description: 'Corte contable asociado; null = se compara contra la foto del sistema',
  })
  readonly accountingCutId!: string | null;

  @ApiProperty({ format: 'date-time' })
  readonly createdAt!: string;

  @ApiProperty({ format: 'uuid' })
  readonly createdBy!: string;

  @ApiProperty({ type: 'string', nullable: true, description: 'Nombre de quien programó la toma; null si el usuario ya no existe' })
  readonly createdByName!: string | null;
}

// ---------- Avisos: destinatarios, advertencias, conflictos, recordatorios ----------

export class InventoryScheduleWarningDto {
  @ApiProperty({ enum: INVENTORY_SCHEDULE_WARNING_CODES, enumName: 'InventoryScheduleWarningCode', description: WARNING_DESCRIPTION })
  readonly code!: InventoryScheduleWarningCode;

  @ApiProperty({ example: 'El centro 3060 no tiene jefe vigente con correo: el aviso y los recordatorios no llegarán por correo a nadie' })
  readonly message!: string;
}

export class InventoryNoticeRecipientDto {
  @ApiProperty({ format: 'uuid' })
  readonly personId!: string;

  @ApiProperty()
  readonly name!: string;

  @ApiProperty({ enum: INVENTORY_NOTICE_ROLES, enumName: 'InventoryNoticeRole' })
  readonly role!: InventoryNoticeRole;

  @ApiProperty({
    type: 'string',
    nullable: true,
    example: 'j***@unac.edu.co',
    description: 'Correo enmascarado (Ley 1581); null si la persona no tiene correo',
  })
  readonly emailMasked!: string | null;

  @ApiProperty({ description: 'Tiene usuario activo en Control Interno (recibe la notificación en la aplicación)' })
  readonly hasUser!: boolean;

  @ApiProperty({ description: 'Recibe el correo (solo jefes de centro con correo)' })
  readonly email!: boolean;

  @ApiProperty({ description: 'Recibe la notificación en la aplicación' })
  readonly inApp!: boolean;
}

export class InventoryConflictDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty()
  readonly code!: string;

  @ApiProperty()
  readonly name!: string;

  @ApiProperty({ enum: INVENTORY_STATUSES, enumName: 'InventoryStatus' })
  readonly status!: InventoryStatus;

  @ApiProperty({ format: 'date' })
  readonly plannedStartDate!: string;

  @ApiProperty({ format: 'date' })
  readonly plannedEndDate!: string;

  @ApiProperty({
    enum: INVENTORY_CONFLICT_REASONS,
    enumName: 'InventoryConflictReason',
    description: 'SAME_SCOPE: mismo alcance; GLOBAL_SCOPE: una de las dos es GLOBAL; SHARED_ASSETS: comparten activos',
  })
  readonly reason!: InventoryConflictReason;
}

export class InventoryReminderDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ type: 'integer', minimum: 0, maximum: 365 })
  readonly offsetDays!: number;

  @ApiProperty({ format: 'date-time', description: '07:00 de Bogotá del día (inicio - offsetDays)' })
  readonly dueAt!: string;

  @ApiProperty({ enum: REMINDER_STATUSES, enumName: 'InventoryReminderStatus' })
  readonly status!: (typeof REMINDER_STATUSES)[number];

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly sentAt!: string | null;
}

/** POST /inventories y POST /inventories/:id/reschedule. */
export class InventoryScheduleResponseDto extends InventorySummaryDto {
  @ApiProperty({ type: [InventoryReminderDto], description: 'Recordatorios de la revisión vigente de fechas' })
  readonly reminders!: InventoryReminderDto[];

  @ApiProperty({ type: [InventoryNoticeRecipientDto], description: 'A quién se avisó (y se recordará)' })
  readonly noticeRecipients!: InventoryNoticeRecipientDto[];

  @ApiProperty({ type: [InventoryScheduleWarningDto] })
  readonly warnings!: InventoryScheduleWarningDto[];

  @ApiProperty({ type: [InventoryConflictDto], description: 'Otras tomas planeadas o en curso que cruzan fechas' })
  readonly conflicts!: InventoryConflictDto[];
}

/** POST /inventories/:id/cancel. */
export class InventoryCancelResponseDto extends InventorySummaryDto {
  @ApiProperty({ type: [InventoryNoticeRecipientDto] })
  readonly noticeRecipients!: InventoryNoticeRecipientDto[];

  @ApiProperty({ type: [InventoryScheduleWarningDto] })
  readonly warnings!: InventoryScheduleWarningDto[];
}

// ---------- GET /inventories/calendar ----------

export class InventoryCostCenterRefDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ example: '3060' })
  readonly code!: string;

  @ApiProperty()
  readonly name!: string;
}

export class InventoryUnitRefDto {
  @ApiProperty({ example: 'VRF' })
  readonly code!: string;

  @ApiProperty()
  readonly name!: string;
}

export class InventoryPersonRefDto {
  @ApiProperty({ format: 'uuid', description: 'Usuario responsable' })
  readonly id!: string;

  @ApiProperty({ type: 'string', nullable: true, description: 'Nombre de la persona del usuario' })
  readonly name!: string | null;
}

export class InventoryCalendarItemDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty()
  readonly code!: string;

  @ApiProperty()
  readonly name!: string;

  @ApiProperty({ enum: INVENTORY_STATUSES, enumName: 'InventoryStatus' })
  readonly status!: InventoryStatus;

  @ApiProperty({ enum: INVENTORY_SCOPE_TYPES, enumName: 'InventoryScopeType' })
  readonly scope!: InventoryScopeType;

  @ApiProperty({ example: 'Centro de costo 3060 · Talento Humano', description: 'Etiqueta legible del alcance' })
  readonly scopeLabel!: string;

  @ApiProperty({ type: InventoryCostCenterRefDto, nullable: true, description: 'Solo en alcance COST_CENTER' })
  readonly costCenter!: InventoryCostCenterRefDto | null;

  @ApiProperty({
    type: InventoryUnitRefDto,
    nullable: true,
    description:
      'COST_CENTER: unidad del centro vigente al inicio de la toma (fin del día de plannedStartDate, hora de Colombia, historial de ubicaciones); ORG_UNIT: la unidad del alcance; null en GLOBAL, LOCATION o si el centro no tenía unidad en esa fecha',
  })
  readonly organizationalUnit!: InventoryUnitRefDto | null;

  @ApiProperty({ format: 'date' })
  readonly plannedStartDate!: string;

  @ApiProperty({ format: 'date' })
  readonly plannedEndDate!: string;

  @ApiProperty()
  readonly rescheduled!: boolean;

  @ApiProperty({ type: 'integer', minimum: 0 })
  readonly rescheduleCount!: number;

  @ApiProperty({ type: InventoryPersonRefDto })
  readonly responsible!: InventoryPersonRefDto;

  @ApiProperty({
    type: [InventoryConflictDto],
    description: 'Solo en tomas planeadas o en curso: otras planeadas o en curso que cruzan fechas (pueden caer fuera de la ventana)',
  })
  readonly conflicts!: InventoryConflictDto[];
}

export class InventoryWeekWarningDto {
  @ApiProperty({ example: '2026-W43', description: 'Semana ISO (lunes a domingo)' })
  readonly isoWeek!: string;

  @ApiProperty({ format: 'date' })
  readonly weekStart!: string;

  @ApiProperty({ format: 'date' })
  readonly weekEnd!: string;

  @ApiProperty({ type: 'integer', description: 'Tomas cuyo rango toca la semana' })
  readonly count!: number;

  @ApiProperty({ type: 'integer' })
  readonly threshold!: number;

  @ApiProperty({ type: [String] })
  readonly inventoryIds!: string[];
}

export class InventoryCalendarResponseDto {
  @ApiProperty({ format: 'date' })
  readonly from!: string;

  @ApiProperty({ format: 'date' })
  readonly to!: string;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    description:
      'Umbral de concentración semanal (INVENTORY_WEEKLY_CONCENTRATION_THRESHOLD). null: no configurado, no se evalúa',
  })
  readonly weeklyThreshold!: number | null;

  @ApiProperty({ type: [InventoryCalendarItemDto] })
  readonly items!: InventoryCalendarItemDto[];

  @ApiProperty({ type: [InventoryWeekWarningDto], description: 'Semanas con más tomas que el umbral; [] sin umbral' })
  readonly weekWarnings!: InventoryWeekWarningDto[];
}

// ---------- GET /inventories/coverage ----------

export class InventoryCoverageLastDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty()
  readonly code!: string;

  @ApiProperty({ format: 'date-time' })
  readonly closedAt!: string;

  @ApiProperty({ enum: INVENTORY_COVERAGE_CLOSED_STATUSES, enumName: 'InventoryCoverageClosedStatus' })
  readonly status!: (typeof INVENTORY_COVERAGE_CLOSED_STATUSES)[number];

  @ApiProperty({ enum: INVENTORY_SCOPE_TYPES, enumName: 'InventoryScopeType' })
  readonly scope!: InventoryScopeType;

  @ApiProperty({
    type: InventoryUnitRefDto,
    nullable: true,
    description: 'Unidad del centro vigente al cierre de esa toma (closedAt); null si no tenía unidad entonces',
  })
  readonly organizationalUnit!: InventoryUnitRefDto | null;
}

export class InventoryCoverageResultDto {
  @ApiProperty({ type: 'integer', description: 'Activos del centro esperados en esa toma' })
  readonly expected!: number;

  @ApiProperty({ type: 'integer' })
  readonly notFound!: number;

  @ApiProperty({ type: 'integer' })
  readonly misplaced!: number;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    description: 'Sobrantes: solo atribuibles al centro si la toma era de ese centro; null en otros alcances',
  })
  readonly unexpected!: number | null;
}

export class InventoryCoverageNextDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty()
  readonly code!: string;

  @ApiProperty({ format: 'date' })
  readonly plannedStartDate!: string;

  @ApiProperty({ format: 'date' })
  readonly plannedEndDate!: string;

  @ApiProperty({ enum: INVENTORY_SCOPE_TYPES, enumName: 'InventoryScopeType' })
  readonly scope!: InventoryScopeType;
}

export class InventoryCoverageItemDto {
  @ApiProperty({ type: InventoryCostCenterRefDto })
  readonly costCenter!: InventoryCostCenterRefDto;

  @ApiProperty({ type: InventoryUnitRefDto, nullable: true, description: 'Unidad actual del centro; null si no tiene' })
  readonly organizationalUnit!: InventoryUnitRefDto | null;

  @ApiProperty({ type: 'integer', description: 'Activos actuales del centro, sin dados de baja (WRITTEN_OFF)' })
  readonly activeAssets!: number;

  @ApiProperty({ type: InventoryCoverageLastDto, nullable: true, description: 'null: el centro nunca se revisó' })
  readonly lastInventory!: InventoryCoverageLastDto | null;

  @ApiProperty({ type: InventoryCoverageResultDto, nullable: true })
  readonly lastResult!: InventoryCoverageResultDto | null;

  @ApiProperty({ type: 'number', nullable: true, description: 'notFound / expected de la última toma (0..1)' })
  readonly notFoundRate!: number | null;

  @ApiProperty({ type: 'integer', nullable: true, description: 'Días calendario (Bogotá) desde el cierre de la última toma' })
  readonly daysSinceLast!: number | null;

  @ApiProperty({ type: InventoryCoverageNextDto, nullable: true, description: 'Próxima toma PLANNED con inicio desde hoy' })
  readonly nextScheduled!: InventoryCoverageNextDto | null;
}

export class InventoryCoverageResponseDto {
  @ApiProperty({ format: 'date', description: 'Hoy en Bogotá (base de daysSinceLast)' })
  readonly today!: string;

  @ApiProperty({ type: 'integer', description: 'Centros de costo con activos actuales' })
  readonly costCenters!: number;

  @ApiProperty({ type: 'integer' })
  readonly neverInventoried!: number;

  @ApiProperty({
    type: [InventoryCoverageItemDto],
    description: 'Orden: nunca revisados, luego más días desde la última toma, luego peor tasa de no encontrados',
  })
  readonly items!: InventoryCoverageItemDto[];
}
