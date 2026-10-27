import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';

export const ASSET_REQUEST_STATUSES = [
  'REQUESTED',
  'ACCEPTED',
  'CLOSED_BY_OWNER',
  'RETURNED',
  'LOAN_SCHEDULED',
  'DOCUMENT_GENERATED',
  'CLOSED_LOAN_REJECTED',
  'CLOSED_LOAN_CANCELLED',
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
  ACCEPTED: ['LOAN_SCHEDULED', 'DOCUMENT_GENERATED', 'RETURNED', 'EXPIRED'],
  RETURNED: ['REQUESTED', 'ACCEPTED', 'CANCELLED', 'EXPIRED'],
  LOAN_SCHEDULED: ['DOCUMENT_GENERATED', 'CLOSED_LOAN_REJECTED', 'CLOSED_LOAN_CANCELLED'],
  CLOSED_BY_OWNER: [],
  DOCUMENT_GENERATED: [],
  CLOSED_LOAN_REJECTED: [],
  CLOSED_LOAN_CANCELLED: [],
  CANCELLED: [],
  EXPIRED: [],
};

export const canAssetRequestTransition = (from: AssetRequestStatus, to: AssetRequestStatus): boolean =>
  TRANSITIONS[from].includes(to);

export const assertAssetRequestTransition = (from: AssetRequestStatus, to: AssetRequestStatus): void => {
  if (!canAssetRequestTransition(from, to)) {
    throw new ApiException(
      ErrorCode.AssetRequestInvalidStateTransition,
      'La solicitud no admite esa acción en su estado actual.',
    );
  }
};

export const HOLDING_STATUSES: ReadonlyArray<AssetRequestStatus> = ['ACCEPTED', 'RETURNED'];

export const ASSET_REQUEST_EXPIRY_DAYS = 14;

export const ASSET_REQUEST_ENTITY_TYPE = 'ASSET_REQUEST';
export const ASSET_REQUEST_REVIEW = 'asset_request:review:global';
export const ASSET_REQUEST_READ_GLOBAL = 'asset_request:read:global';

export const EXPIRING_STATUSES: ReadonlyArray<AssetRequestStatus> = ['ACCEPTED', 'RETURNED'];

export const REASON_MIN = 3;
export const REASON_MAX = 500;

export const statusAfterCorrection = (changed: {
  readonly ownerCostCenter: boolean;
  readonly kind: boolean;
  readonly requestingCostCenter: boolean;
}): AssetRequestStatus =>
  changed.ownerCostCenter || changed.kind || changed.requestingCostCenter ? 'REQUESTED' : 'ACCEPTED';
