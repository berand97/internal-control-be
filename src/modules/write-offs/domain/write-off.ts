export const WRITE_OFF_STATUSES = ['DRAFT', 'PENDING_SIGNATURES', 'COMPLETED', 'REJECTED', 'CANCELLED'] as const;
export type WriteOffStatus = (typeof WRITE_OFF_STATUSES)[number];

export const OPEN_WRITE_OFF_STATUSES: ReadonlyArray<WriteOffStatus> = ['DRAFT', 'PENDING_SIGNATURES'];

const TRANSITIONS: Readonly<Record<WriteOffStatus, ReadonlyArray<WriteOffStatus>>> = {
  DRAFT: ['PENDING_SIGNATURES', 'CANCELLED'],
  PENDING_SIGNATURES: ['COMPLETED', 'REJECTED', 'CANCELLED'],
  COMPLETED: [],
  REJECTED: [],
  CANCELLED: [],
};

export const canWriteOffTransition = (from: WriteOffStatus, to: WriteOffStatus): boolean => TRANSITIONS[from].includes(to);

export const isWriteOffEditable = (status: WriteOffStatus): boolean => status === 'DRAFT';

export const WRITE_OFF_ITEM_STATES = ['OBSOLETE', 'DAMAGED', 'STOLEN', 'NOT_AN_ASSET', 'OTHER'] as const;
export type WriteOffItemState = (typeof WRITE_OFF_ITEM_STATES)[number];

export const WRITE_OFF_ITEM_STATE_LABELS: Readonly<Record<WriteOffItemState, string>> = {
  OBSOLETE: 'Obsoleto',
  DAMAGED: 'Dañado',
  STOLEN: 'Robado',
  NOT_AN_ASSET: 'No es activo',
  OTHER: 'Otro',
};

export const writeOffItemReason = (state: WriteOffItemState, notes: string | null): string => {
  const extra = notes?.trim() ?? '';
  return extra ? `${WRITE_OFF_ITEM_STATE_LABELS[state]}. ${extra}` : WRITE_OFF_ITEM_STATE_LABELS[state];
};

export const WRITE_OFF_ENTITY_TYPE = 'WRITE_OFF';
export const WRITE_OFF_FORMAT_KEY = 'OCI-17-90-BAJA';

export const WRITE_OFF_SIGNER_SOURCES = {
  CONTROL_INTERNO: 'REQUEST',
  CONTABILIDAD: 'REQUEST',
} as const;

export const WRITE_OFF_MANAGE = 'asset:write_off:global';
export const ASSET_READ_GLOBAL = 'asset:read:global';
export const ASSET_READ_SCOPED = 'asset:read:org_unit';

export const MAX_WRITE_OFF_ASSETS = 500;
export const MAX_WRITE_OFF_QUANTITY = 10_000;
