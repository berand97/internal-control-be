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

export const TRANSFER_SIGNER_SOURCES = {
  ENTREGA: 'REQUEST',
  RECIBE: 'RESPONSIBLE',
  CONTROL_INTERNO: 'REQUEST',
  CONTABILIDAD: 'REQUEST',
} as const;

export const TRANSFER_READ_GLOBAL = 'transfer:read:global';
export const TRANSFER_SIGN_ACCOUNTING = 'transfer:sign_accounting:global';
export const TRANSFER_CATALOG_MANAGE = 'transfer_catalog:manage:global';
export const TRANSFER_MANAGE = 'asset:update:global';
export const ASSET_READ_GLOBAL = 'asset:read:global';
export const ASSET_READ_SCOPED = 'asset:read:org_unit';

export { CONTROL_SIGNER_PERMISSION } from '../../documents/domain/signer-separation.js';

export const MAX_TRANSFER_ASSETS = 500;
