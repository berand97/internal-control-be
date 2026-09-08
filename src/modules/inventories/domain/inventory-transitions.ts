import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import { InventoryStatus } from '../enums/inventory-status.js';

const ALLOWED: Record<InventoryStatus, ReadonlyArray<InventoryStatus>> = {
  [InventoryStatus.Planned]: [InventoryStatus.InProgress, InventoryStatus.Cancelled],
  [InventoryStatus.InProgress]: [InventoryStatus.Closed, InventoryStatus.Cancelled],
  [InventoryStatus.Closed]: [InventoryStatus.Reconciled],
  [InventoryStatus.Reconciled]: [],
  [InventoryStatus.Cancelled]: [],
};

export const UNVERIFIED_CLOSE_THRESHOLD = 0.05;

export const assertInventoryTransition = (
  from: InventoryStatus,
  to: InventoryStatus,
): void => {
  if (!ALLOWED[from].includes(to)) {
    throw new ApiException(ErrorCode.InvalidState);
  }
};

export const unverifiedRatio = (
  pending: number,
  expected: number,
): number => {
  if (expected <= 0) {
    return 0;
  }
  return pending / expected;
};

export const exceedsUnverifiedThreshold = (
  pending: number,
  expected: number,
): boolean => unverifiedRatio(pending, expected) > UNVERIFIED_CLOSE_THRESHOLD;
