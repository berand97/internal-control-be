import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';

/**
 * Solicitud de activos entre centros de costo (migración 1767225930000).
 *
 * - REQUESTED: un jefe vigente del centro que solicita la envió; espera al jefe del centro dueño.
 * - ACCEPTED: el jefe dueño eligió los activos (quedan reservados); espera a Control Interno. Vence a los
 *   ASSET_REQUEST_EXPIRY_DAYS días (EXPIRED, libera los activos).
 * - CLOSED_BY_OWNER: el jefe dueño dijo que no (motivo). Final.
 * - RETURNED: Control Interno la devolvió al solicitante para corregir (motivo). Los activos siguen reservados.
 * - DOCUMENT_GENERATED: Control Interno generó el préstamo (TEMPORARY) o el traslado (PERMANENT) con su acta. Final
 *   para la solicitud: el documento sigue su propio flujo de firmas.
 * - CANCELLED: el solicitante desistió en REQUESTED o RETURNED (motivo). Final.
 * - EXPIRED: ACCEPTED sin resolución de Control Interno en el plazo. Final.
 */
export const ASSET_REQUEST_STATUSES = [
  'REQUESTED',
  'ACCEPTED',
  'CLOSED_BY_OWNER',
  'RETURNED',
  'DOCUMENT_GENERATED',
  'CANCELLED',
  'EXPIRED',
] as const;
export type AssetRequestStatus = (typeof ASSET_REQUEST_STATUSES)[number];

export const ASSET_REQUEST_KINDS = ['TEMPORARY', 'PERMANENT'] as const;
export type AssetRequestKind = (typeof ASSET_REQUEST_KINDS)[number];

export const ASSET_REQUEST_KIND_LABELS: Record<AssetRequestKind, string> = {
  TEMPORARY: 'Préstamo temporal',
  PERMANENT: 'Traslado permanente',
};

const TRANSITIONS: Readonly<Record<AssetRequestStatus, ReadonlyArray<AssetRequestStatus>>> = {
  REQUESTED: ['ACCEPTED', 'CLOSED_BY_OWNER', 'CANCELLED'],
  ACCEPTED: ['DOCUMENT_GENERATED', 'RETURNED', 'EXPIRED'],
  RETURNED: ['REQUESTED', 'ACCEPTED', 'CANCELLED'],
  CLOSED_BY_OWNER: [],
  DOCUMENT_GENERATED: [],
  CANCELLED: [],
  EXPIRED: [],
};

export const canAssetRequestTransition = (from: AssetRequestStatus, to: AssetRequestStatus): boolean =>
  TRANSITIONS[from].includes(to);

export const assertAssetRequestTransition = (from: AssetRequestStatus, to: AssetRequestStatus): void => {
  if (!canAssetRequestTransition(from, to)) {
    throw new ApiException(
      ErrorCode.AssetRequestInvalidStateTransition,
      `La solicitud está ${from}: no puede pasar a ${to}`,
    );
  }
};

/** Estados en que la solicitud retiene los activos elegidos (asset_request_item.open). */
export const HOLDING_STATUSES: ReadonlyArray<AssetRequestStatus> = ['ACCEPTED', 'RETURNED'];

/** Días que una solicitud ACCEPTED espera a Control Interno antes de vencer (decisión del desarrollador). */
export const ASSET_REQUEST_EXPIRY_DAYS = 14;

export const ASSET_REQUEST_ENTITY_TYPE = 'ASSET_REQUEST';
export const ASSET_REQUEST_REVIEW = 'asset_request:review:global';

/** Motivo de rechazo, devolución o cancelación: obligatorio, 3..500 caracteres. */
export const REASON_MIN = 3;
export const REASON_MAX = 500;

/**
 * Corrección del solicitante sobre una solicitud RETURNED: si cambió algo que el dueño decidió (centro dueño, tipo,
 * centro que solicita; los activos los elige siempre el dueño, el solicitante no los cambia) vuelve al dueño (REQUESTED,
 * se descartan los activos elegidos); si solo
 * cambió descripción, nota o fechas, vuelve a Control Interno (ACCEPTED, con los mismos activos).
 */
export const statusAfterCorrection = (changed: {
  readonly ownerCostCenter: boolean;
  readonly kind: boolean;
  readonly requestingCostCenter: boolean;
}): AssetRequestStatus =>
  changed.ownerCostCenter || changed.kind || changed.requestingCostCenter ? 'REQUESTED' : 'ACCEPTED';
