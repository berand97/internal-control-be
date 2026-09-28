/**
 * Traslado de activos entre centros de costo (acta OCI-17-89, «Traslado de activos»).
 *
 * Estados: DRAFT → PENDING_SIGNATURES → COMPLETED | REJECTED; DRAFT y PENDING_SIGNATURES (sin ninguna firma) →
 * CANCELLED. COMPLETED, REJECTED y CANCELLED son finales.
 * - DRAFT: se arma el traslado (activos del mismo centro de origen, motivo por activo); nada cambia en los activos.
 * - PENDING_SIGNATURES: el acta se encoló (outbox) y se firma en orden ENTREGA, RECIBE, CONTROL_INTERNO, CONTABILIDAD.
 * - COMPLETED: el acta quedó totalmente firmada; en esa misma transacción cada activo pasa al centro de destino con
 *   un movimiento TRANSFER cuyo documentReference es el número del acta.
 * - REJECTED: un firmante rechazó el acta; los activos no se movieron.
 * - CANCELLED: se desistió antes de firmar (la solicitud del acta se cancela o el acta se anula).
 */
export const TRANSFER_STATUSES = ['DRAFT', 'PENDING_SIGNATURES', 'COMPLETED', 'REJECTED', 'CANCELLED'] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

export const OPEN_TRANSFER_STATUSES: ReadonlyArray<TransferStatus> = ['DRAFT', 'PENDING_SIGNATURES'];

const TRANSITIONS: Readonly<Record<TransferStatus, ReadonlyArray<TransferStatus>>> = {
  DRAFT: ['PENDING_SIGNATURES', 'CANCELLED'],
  PENDING_SIGNATURES: ['COMPLETED', 'REJECTED', 'CANCELLED'],
  COMPLETED: [],
  REJECTED: [],
  CANCELLED: [],
};

export const canTransferTransition = (from: TransferStatus, to: TransferStatus): boolean => TRANSITIONS[from].includes(to);

export const TRANSFER_ENTITY_TYPE = 'TRANSFER';
export const TRANSFER_FORMAT_KEY = 'OCI-17-89';

/** Roles del acta que asigna el código del traslado (ProcessFormatBinding del OCI-17-89). */
export const TRANSFER_SIGNER_SOURCES = {
  ENTREGA: 'REQUEST',
  RECIBE: 'RESPONSIBLE',
  CONTROL_INTERNO: 'REQUEST',
  CONTABILIDAD: 'REQUEST',
} as const;

/** Permisos (migración 1767225920000). */
export const TRANSFER_READ_GLOBAL = 'transfer:read:global';
export const TRANSFER_SIGN_ACCOUNTING = 'transfer:sign_accounting:global';
export const TRANSFER_CATALOG_MANAGE = 'transfer_catalog:manage:global';
/** Generar el OCI-17-89 (su generatePermission sembrado): crear, editar, generar y cancelar traslados. */
export const TRANSFER_MANAGE = 'asset:update:global';
export const ASSET_READ_GLOBAL = 'asset:read:global';
export const ASSET_READ_SCOPED = 'asset:read:org_unit';

/** Quién puede firmar el turno CONTROL_INTERNO del traslado: mismo criterio que el sustituto de Control Interno. */
export const CONTROL_SIGNER_ROLE_CODES: ReadonlyArray<string> = ['INTERNAL_CONTROL_DIRECTOR', 'AUDITOR'];

/** Tope técnico de activos por acta (tamaño del documento); no es regla de negocio. */
export const MAX_TRANSFER_ASSETS = 500;
