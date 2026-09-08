export enum OperationalStatus {
  InUse = 'IN_USE',
  InStorage = 'IN_STORAGE',
  OnLoan = 'ON_LOAN',
  InMaintenance = 'IN_MAINTENANCE',
  Lost = 'LOST',
  WrittenOff = 'WRITTEN_OFF',
}

export const OPERATIONAL_STATUSES = [
  OperationalStatus.InUse,
  OperationalStatus.InStorage,
  OperationalStatus.OnLoan,
  OperationalStatus.InMaintenance,
  OperationalStatus.Lost,
  OperationalStatus.WrittenOff,
] as const;
