import type { PhysicalInventory } from '../entities/physical-inventory.entity.js';

/**
 * Resumen de una toma, igual en listado, detalle, programación, reprogramación y cancelación
 * (InventorySummaryDto en dto/inventory-schedule.responses.ts). "Reprogramada" no es un estado: es
 * rescheduleCount > 0.
 */
export const inventorySummary = (inventory: PhysicalInventory) => ({
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
  notes: inventory.scopeNotes,
  closedAt: inventory.closedAt,
  closedBy: inventory.closedBy,
  reconcileRequestedAt: inventory.reconcileRequestedAt,
  reconcileRequestedBy: inventory.reconcileRequestedBy,
  reconcileApprovedAt: inventory.reconcileApprovedAt,
  reconcileApprovedBy: inventory.reconcileApprovedBy,
  rescheduled: (inventory.rescheduleCount ?? 0) > 0,
  rescheduleCount: inventory.rescheduleCount ?? 0,
  rescheduledAt: inventory.rescheduledAt ?? null,
  reminderOffsetsDays: [...(inventory.reminderOffsetsDays ?? [])],
  cancelReason: inventory.cancelReason ?? null,
  cancelledAt: inventory.cancelledAt ?? null,
  cancelledBy: inventory.cancelledBy ?? null,
  createdAt: inventory.createdAt,
  createdBy: inventory.createdBy,
});

export type InventorySummary = ReturnType<typeof inventorySummary>;
