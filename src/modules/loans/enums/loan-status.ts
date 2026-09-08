export const LOAN_STATUSES = [
  'REQUESTED',
  'APPROVED',
  'REJECTED',
  'IN_TRANSIT',
  'ACTIVE',
  'OVERDUE',
  'PENDING_RECEPTION',
  'RETURNED',
  'PARTIALLY_RETURNED',
  'CANCELLED',
] as const;

export type LoanStatus = (typeof LOAN_STATUSES)[number];

export const ACTIVE_LOAN_STATUSES: ReadonlyArray<LoanStatus> = [
  'APPROVED',
  'IN_TRANSIT',
  'ACTIVE',
  'OVERDUE',
  'PENDING_RECEPTION',
];

export const LOAN_RETURN_CONDITIONS = ['GOOD', 'DAMAGED', 'LOST'] as const;
export type LoanReturnCondition = (typeof LOAN_RETURN_CONDITIONS)[number];
