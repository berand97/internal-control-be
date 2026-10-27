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

export const WRITE_OFF_REASONS = [
  'OBSOLESCENCE',
  'IRREPARABLE_DAMAGE',
  'LOSS',
  'THEFT',
  'DONATION',
  'PERMANENT_TRANSFER',
  'OTHER',
] as const;
export type WriteOffReason = (typeof WRITE_OFF_REASONS)[number];

export const WRITE_OFF_REASON_LABELS: Readonly<Record<WriteOffReason, string>> = {
  OBSOLESCENCE: 'Obsolescencia',
  IRREPARABLE_DAMAGE: 'Daño irreparable',
  LOSS: 'Pérdida',
  THEFT: 'Hurto',
  DONATION: 'Donación',
  PERMANENT_TRANSFER: 'Traslado definitivo',
  OTHER: 'Otro',
};

export const writeOffReasonText = (reason: WriteOffReason, detail: string | null): string => {
  const extra = detail?.trim() ?? '';
  if (reason === 'OTHER') {
    return extra || WRITE_OFF_REASON_LABELS.OTHER;
  }
  return extra ? `${WRITE_OFF_REASON_LABELS[reason]}. ${extra}` : WRITE_OFF_REASON_LABELS[reason];
};

export const WRITE_OFF_ENTITY_TYPE = 'WRITE_OFF';
export const WRITE_OFF_FORMAT_KEY = 'OCI-17-90-BAJA';

export const WRITE_OFF_SIGNER_SOURCES = {
  RESPONSABLE: 'RESPONSIBLE',
  AUDITA: 'REQUEST',
} as const;

export const WRITE_OFF_MANAGE = 'asset:write_off:global';
export const ASSET_READ_GLOBAL = 'asset:read:global';
export const ASSET_READ_SCOPED = 'asset:read:org_unit';

export const MAX_WRITE_OFF_ASSETS = 500;
