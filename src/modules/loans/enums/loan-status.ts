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

/** Préstamos con los activos fuera (ON_LOAN): entregados y aún no recibidos de vuelta. */
export const LOAN_OUT_STATUSES: ReadonlyArray<LoanStatus> = ['ACTIVE', 'OVERDUE', 'PENDING_RECEPTION'];

/** Préstamos que pueden estar vencidos (alerta de vencidos y job diario). */
export const LOAN_OVERDUE_CANDIDATE_STATUSES: ReadonlyArray<LoanStatus> = ['ACTIVE', 'OVERDUE'];
