import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { LoanStatus } from '../enums/loan-status.js';

const ALLOWED: Record<LoanStatus, ReadonlyArray<LoanStatus>> = {
  REQUESTED: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['PENDING_SIGNATURES', 'IN_TRANSIT', 'REJECTED', 'CANCELLED'],
  REJECTED: [],
  IN_TRANSIT: ['ACTIVE'],
  PENDING_SIGNATURES: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['PENDING_RECEPTION', 'OVERDUE'],
  OVERDUE: ['PENDING_RECEPTION', 'ACTIVE'],
  PENDING_RECEPTION: ['RETURNED', 'PARTIALLY_RETURNED', 'CLOSED_WITH_LOSSES'],
  RETURNED: [],
  PARTIALLY_RETURNED: ['PENDING_RECEPTION'],
  CLOSED_WITH_LOSSES: [],
  CANCELLED: [],
};

export const canTransition = (from: LoanStatus, to: LoanStatus): boolean => ALLOWED[from].includes(to);

export const assertLoanTransition = (
  from: LoanStatus,
  to: LoanStatus,
): void => {
  if (!canTransition(from, to)) {
    throw new ApiException(ErrorCode.InvalidLoanStateTransition);
  }
};

export const statusAfterReception = (
  items: ReadonlyArray<{ readonly received: boolean; readonly lost: boolean }>,
): LoanStatus => {
  if (items.some((item) => !item.received)) {
    return 'PARTIALLY_RETURNED';
  }
  return items.some((item) => item.lost) ? 'CLOSED_WITH_LOSSES' : 'RETURNED';
};
