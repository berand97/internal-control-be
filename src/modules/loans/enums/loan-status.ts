/**
 * Estados del préstamo (asset_loan.status, tipo PostgreSQL loan_status). Decisiones en docs/decisiones.md:
 * - PENDING_SIGNATURES: los activos se entregaron físicamente (ON_LOAN, movimiento LOAN) y el acta OCI-01-65 aún
 *   no tiene todas sus firmas (pendiente de generar, fallida, pendiente de firma o rechazada). Pasa a ACTIVE en la
 *   transacción que firma el acta (onSigned), o a CANCELLED si se deshace la entrega.
 * - IN_TRANSIT: heredado del esquema, sin uso: ningún endpoint lo produce (ver docs/decisiones.md, 5b).
 * - PARTIALLY_RETURNED: se recibió una devolución y quedan activos fuera, sin resolver. Abierto: admite otra
 *   devolución (POST /loans/:id/return) de los pendientes, devueltos o declarados perdidos.
 * - CLOSED_WITH_LOSSES: todos los activos resueltos y al menos uno declarado perdido (LOST). Cerrado.
 * - RETURNED: todos los activos devueltos (GOOD o DAMAGED). Cerrado.
 */
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

/**
 * Préstamos abiertos: un activo en uno de ellos no entra en otra solicitud. Incluye REQUESTED (dos solicitudes no
 * reservan el mismo activo) y PARTIALLY_RETURNED (sus activos sin resolver siguen fuera).
 */
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

/** Cuentan para el responsable de los activos (ActiveLoansPort): aprobados y con activos fuera. */
export const ACTIVE_LOAN_STATUSES: ReadonlyArray<LoanStatus> = OPEN_LOAN_STATUSES.filter((status) => status !== 'REQUESTED');

export const LOAN_RETURN_CONDITIONS = ['GOOD', 'DAMAGED', 'LOST'] as const;
export type LoanReturnCondition = (typeof LOAN_RETURN_CONDITIONS)[number];

/** Préstamos con activos fuera (ON_LOAN): entregados y con algún activo aún sin recibir de vuelta. */
export const LOAN_OUT_STATUSES: ReadonlyArray<LoanStatus> = [
  'PENDING_SIGNATURES',
  'ACTIVE',
  'OVERDUE',
  'PENDING_RECEPTION',
  'PARTIALLY_RETURNED',
];

/**
 * Préstamos que cuentan como vencidos si la fecha estimada ya pasó (alerta y filtro overdue=true): los que tienen
 * activos fuera y todavía no se están recibiendo. PENDING_SIGNATURES cuenta: los activos salieron y la obligación
 * de devolverlos no depende del papeleo. El job diario solo marca OVERDUE a los ACTIVE (markOverdue).
 */
export const LOAN_OVERDUE_CANDIDATE_STATUSES: ReadonlyArray<LoanStatus> = [
  'PENDING_SIGNATURES',
  'ACTIVE',
  'OVERDUE',
  'PARTIALLY_RETURNED',
];
