import type { PhysicalInventory } from '../entities/physical-inventory.entity.js';

/** Nombre visible de un usuario: nombres y apellidos de su persona o, si no tiene, su usuario. */
export const USER_DISPLAY_NAME_SQL = (user: string, person: string): string =>
  `coalesce(nullif(trim(coalesce(${person}.first_name, '') || ' ' || coalesce(${person}.last_name, '')), ''), ${user}.username)`;

export type ResponsibleNames = ReadonlyMap<string, string>;

/**
 * Nombres de los responsables de varias tomas en una consulta. Quien consulta la toma no necesita user:read:global
 * para ver quién la tiene a cargo (la Directora programa tomas sin administrar usuarios).
 */
export const loadResponsibleNames = async (
  runner: { query(sql: string, parameters?: unknown[]): Promise<unknown> },
  userIds: ReadonlyArray<string | null | undefined>,
): Promise<ResponsibleNames> => {
  const ids = [...new Set(userIds.filter((id): id is string => typeof id === 'string'))];
  if (ids.length === 0) {
    return new Map();
  }
  const rows = (await runner.query(
    `SELECT u.id, ${USER_DISPLAY_NAME_SQL('u', 'p')} AS name
     FROM app_user u LEFT JOIN person p ON p.id = u.person_id
     WHERE u.id = ANY($1::uuid[])`,
    [ids],
  )) as Array<{ id: string; name: string }>;
  return new Map(rows.map((row) => [row.id, row.name]));
};

/** Usuarios citados en el resumen de una toma (responsable y cada `*By`), para resolver sus nombres de una vez. */
export const inventorySummaryUserIds = (inventory: PhysicalInventory): Array<string | null | undefined> => [
  inventory.responsibleUserId,
  inventory.closedBy,
  inventory.reconcileRequestedBy,
  inventory.reconcileApprovedBy,
  inventory.cancelledBy,
  inventory.createdBy,
];

const nameOf = (names: ResponsibleNames, id: string | null | undefined): string | null =>
  id ? (names.get(id) ?? null) : null;

/**
 * Resumen de una toma, igual en listado, detalle, programación, reprogramación y cancelación
 * (InventorySummaryDto en dto/inventory-schedule.responses.ts). "Reprogramada" no es un estado: es
 * rescheduleCount > 0.
 */
export const inventorySummary = (inventory: PhysicalInventory, names: ResponsibleNames) => ({
  id: inventory.id,
  code: inventory.code,
  name: inventory.name,
  status: inventory.status,
  scope: inventory.scopeType,
  scopeId: inventory.scopeId,
  plannedStartDate: inventory.plannedStartDate,
  plannedEndDate: inventory.plannedEndDate,
  actualStartDate: inventory.actualStartDate,
  actualEndDate: inventory.actualEndDate,
  responsibleUserId: inventory.responsibleUserId,
  responsible: { id: inventory.responsibleUserId, name: names.get(inventory.responsibleUserId) ?? '' },
  notes: inventory.scopeNotes,
  closedAt: inventory.closedAt,
  closedBy: inventory.closedBy,
  closedByName: nameOf(names, inventory.closedBy),
  reconcileRequestedAt: inventory.reconcileRequestedAt,
  reconcileRequestedBy: inventory.reconcileRequestedBy,
  reconcileRequestedByName: nameOf(names, inventory.reconcileRequestedBy),
  reconcileApprovedAt: inventory.reconcileApprovedAt,
  reconcileApprovedBy: inventory.reconcileApprovedBy,
  reconcileApprovedByName: nameOf(names, inventory.reconcileApprovedBy),
  rescheduled: (inventory.rescheduleCount ?? 0) > 0,
  rescheduleCount: inventory.rescheduleCount ?? 0,
  rescheduledAt: inventory.rescheduledAt ?? null,
  reminderOffsetsDays: [...(inventory.reminderOffsetsDays ?? [])],
  cancelReason: inventory.cancelReason ?? null,
  cancelledAt: inventory.cancelledAt ?? null,
  cancelledBy: inventory.cancelledBy ?? null,
  cancelledByName: nameOf(names, inventory.cancelledBy),
  accountingCutId: inventory.accountingCutId ?? null,
  createdAt: inventory.createdAt,
  createdBy: inventory.createdBy,
  createdByName: nameOf(names, inventory.createdBy),
});

export type InventorySummary = ReturnType<typeof inventorySummary>;
