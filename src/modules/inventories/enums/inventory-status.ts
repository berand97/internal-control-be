export enum InventoryStatus {
  Planned = 'PLANNED',
  InProgress = 'IN_PROGRESS',
  Closed = 'CLOSED',
  Reconciled = 'RECONCILED',
  Cancelled = 'CANCELLED',
}

export const INVENTORY_STATUSES = [
  InventoryStatus.Planned,
  InventoryStatus.InProgress,
  InventoryStatus.Closed,
  InventoryStatus.Reconciled,
  InventoryStatus.Cancelled,
] as const;

export const OPEN_INVENTORY_STATUSES: ReadonlyArray<InventoryStatus> = [
  InventoryStatus.Planned,
  InventoryStatus.InProgress,
];
