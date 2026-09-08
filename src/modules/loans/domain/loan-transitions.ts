import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { LoanStatus } from '../enums/loan-status.js';

const ALLOWED: Record<LoanStatus, ReadonlyArray<LoanStatus>> = {
  REQUESTED: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['ACTIVE', 'IN_TRANSIT', 'REJECTED'],
  REJECTED: [],
  IN_TRANSIT: ['ACTIVE'],
  ACTIVE: ['PENDING_RECEPTION', 'OVERDUE'],
  OVERDUE: ['PENDING_RECEPTION'],
  PENDING_RECEPTION: ['RETURNED', 'PARTIALLY_RETURNED'],
  RETURNED: [],
  PARTIALLY_RETURNED: [],
  CANCELLED: [],
};

export const assertLoanTransition = (
  from: LoanStatus,
  to: LoanStatus,
): void => {
  if (!ALLOWED[from].includes(to)) {
    throw new ApiException(ErrorCode.InvalidLoanStateTransition);
  }
};
