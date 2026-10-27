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

export const OPERATIONAL_STATUS_PHRASE: Record<OperationalStatus, string> = {
  [OperationalStatus.InUse]: 'en uso',
  [OperationalStatus.InStorage]: 'en bodega',
  [OperationalStatus.OnLoan]: 'prestado',
  [OperationalStatus.InMaintenance]: 'en mantenimiento',
  [OperationalStatus.Lost]: 'perdido',
  [OperationalStatus.WrittenOff]: 'dado de baja',
};

export const operationalStatusPhraseSql = (column: string): string =>
  `CASE ${column}::text ${Object.entries(OPERATIONAL_STATUS_PHRASE)
    .map(([status, phrase]) => `WHEN '${status}' THEN '${phrase}'`)
    .join(' ')} ELSE ${column}::text END`;
