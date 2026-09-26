import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { LoanStatus } from '../enums/loan-status.js';

/**
 * Transiciones permitidas (docs/decisiones.md):
 * - APPROVED → PENDING_SIGNATURES: entrega física (POST /loans/:id/deliver).
 * - PENDING_SIGNATURES → ACTIVE: el acta OCI-01-65 queda firmada (onSigned, misma transacción).
 * - PENDING_SIGNATURES → CANCELLED: se deshace la entrega (POST /loans/:id/undo-delivery).
 * - OVERDUE → ACTIVE: se aprueba una extensión con fecha no vencida.
 * - PENDING_RECEPTION → RETURNED | PARTIALLY_RETURNED | CLOSED_WITH_LOSSES: recepción de la devolución.
 * - PARTIALLY_RETURNED → PENDING_RECEPTION: devolución (o pérdida) de los activos que seguían fuera.
 * - IN_TRANSIT: heredado, ningún endpoint lo produce.
 */
const ALLOWED: Record<LoanStatus, ReadonlyArray<LoanStatus>> = {
  REQUESTED: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['PENDING_SIGNATURES', 'IN_TRANSIT', 'REJECTED'],
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

/**
 * Estado del préstamo después de recibir una devolución, a partir de sus activos:
 * - alguno sigue fuera (sin devolución registrada) → PARTIALLY_RETURNED;
 * - todos resueltos y alguno perdido → CLOSED_WITH_LOSSES;
 * - todos devueltos → RETURNED.
 */
export const statusAfterReception = (
  items: ReadonlyArray<{ readonly received: boolean; readonly lost: boolean }>,
): LoanStatus => {
  if (items.some((item) => !item.received)) {
    return 'PARTIALLY_RETURNED';
  }
  return items.some((item) => item.lost) ? 'CLOSED_WITH_LOSSES' : 'RETURNED';
};
