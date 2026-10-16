export const LOAN_STATUSES = [
  'REQUESTED',
  'APPROVED',
  'REJECTED',
  'IN_TRANSIT',
  'PENDING_SIGNATURES',
  'ACTIVE',
  'OVERDUE',
  'PENDING_RECEPTION',
  'RETURNED',
  'PARTIALLY_RETURNED',
  'CLOSED_WITH_LOSSES',
  'CANCELLED',
] as const;

export type LoanStatus = (typeof LOAN_STATUSES)[number];

export const OPEN_LOAN_STATUSES: ReadonlyArray<LoanStatus> = [
  'REQUESTED',
  'APPROVED',
  'IN_TRANSIT',
  'PENDING_SIGNATURES',
  'ACTIVE',
  'OVERDUE',
  'PENDING_RECEPTION',
  'PARTIALLY_RETURNED',
];

export const ACTIVE_LOAN_STATUSES: ReadonlyArray<LoanStatus> = OPEN_LOAN_STATUSES.filter((status) => status !== 'REQUESTED');

export const LOAN_RETURN_CONDITIONS = ['GOOD', 'DAMAGED', 'LOST'] as const;
export type LoanReturnCondition = (typeof LOAN_RETURN_CONDITIONS)[number];

export const LOAN_OUT_STATUSES: ReadonlyArray<LoanStatus> = [
  'PENDING_SIGNATURES',
  'ACTIVE',
  'OVERDUE',
  'PENDING_RECEPTION',
  'PARTIALLY_RETURNED',
];

export const LOAN_OVERDUE_CANDIDATE_STATUSES: ReadonlyArray<LoanStatus> = [
  'PENDING_SIGNATURES',
  'ACTIVE',
  'OVERDUE',
  'PARTIALLY_RETURNED',
];
