import { OperationalStatus } from '../enums/operational-status.enum.js';

const ALLOWED: Readonly<Record<OperationalStatus, ReadonlyArray<OperationalStatus>>> =
  {
    [OperationalStatus.InUse]: [
      OperationalStatus.InStorage,
      OperationalStatus.InMaintenance,
      OperationalStatus.Lost,
    ],
    [OperationalStatus.InStorage]: [
      OperationalStatus.InUse,
      OperationalStatus.InMaintenance,
      OperationalStatus.Lost,
    ],
    [OperationalStatus.InMaintenance]: [
      OperationalStatus.InUse,
      OperationalStatus.InStorage,
    ],
    [OperationalStatus.Lost]: [
      OperationalStatus.InUse,
      OperationalStatus.InStorage,
      OperationalStatus.InMaintenance,
    ],
    [OperationalStatus.OnLoan]: [],
    [OperationalStatus.WrittenOff]: [],
  };

export const canTransitionStatus = (
  from: OperationalStatus,
  to: OperationalStatus,
): boolean => ALLOWED[from].includes(to);
