import { OperationalStatus } from '../../assets/enums/operational-status.enum.js';

/** entity_type de las actas de entrega en document / document_request: reservado a este proceso. */
export const HANDOVER_ENTITY_TYPE = 'HANDOVER';

/** Acta de entrega y asignación de activos fijos. Firmantes (catálogo): RECIBE (responsable) → AUDITA (Control Interno). */
export const HANDOVER_FORMAT_KEY = 'OCI-01-55';

/**
 * AWAITING_DOCUMENT: creada, su acta está en el outbox (pendiente o fallida).
 * PENDING_SIGNATURE: acta generada, esperando firmas.
 * SIGNED: acta firmada; cada activo tiene como responsable al firmante RECIBE final.
 * REJECTED: un firmante rechazó el acta; los activos no cambiaron.
 * CANCELLED: cancelada antes de firmarse (POST /handovers/:id/cancel): solicitud CANCELLED o acta VOIDED, activos
 *   liberados, sin cambios en ellos.
 */
export const HANDOVER_STATUSES = ['AWAITING_DOCUMENT', 'PENDING_SIGNATURE', 'SIGNED', 'REJECTED', 'CANCELLED'] as const;

/** Estados desde los que se puede cancelar: antes de que el acta quede firmada o rechazada. */
export const CANCELLABLE_HANDOVER_STATUSES: ReadonlyArray<HandoverStatus> = ['AWAITING_DOCUMENT', 'PENDING_SIGNATURE'];
export type HandoverStatus = (typeof HANDOVER_STATUSES)[number];

/**
 * Estados operativos con los que un activo no se entrega: dado de baja o en préstamo son incompatibles de forma
 * evidente con asignarle un responsable. LOST, IN_MAINTENANCE e IN_STORAGE quedan abiertos: pregunta a Control Interno.
 */
export const NOT_DELIVERABLE_STATUSES: ReadonlyArray<OperationalStatus> = [
  OperationalStatus.WrittenOff,
  OperationalStatus.OnLoan,
];

export const GENERATION_STATUSES = ['PENDING', 'FAILED', 'GENERATED'] as const;
