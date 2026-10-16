import { OperationalStatus } from '../../assets/enums/operational-status.enum.js';

export const HANDOVER_ENTITY_TYPE = 'HANDOVER';

export const HANDOVER_FORMAT_KEY = 'OCI-01-55';

export const HANDOVER_STATUSES = ['AWAITING_DOCUMENT', 'PENDING_SIGNATURE', 'SIGNED', 'REJECTED', 'CANCELLED'] as const;

export const CANCELLABLE_HANDOVER_STATUSES: ReadonlyArray<HandoverStatus> = ['AWAITING_DOCUMENT', 'PENDING_SIGNATURE'];
export type HandoverStatus = (typeof HANDOVER_STATUSES)[number];

export const NOT_DELIVERABLE_STATUSES: ReadonlyArray<OperationalStatus> = [
  OperationalStatus.WrittenOff,
  OperationalStatus.OnLoan,
];

export const GENERATION_STATUSES = ['PENDING', 'FAILED', 'GENERATED'] as const;
