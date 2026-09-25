import { createHmac } from 'node:crypto';

export const SIGNATURE_VERSION = 2;

export interface MovementStateSnapshot {
  readonly costCenterId: string | null;
  readonly locationId: string | null;
  readonly responsibleId: string | null;
  readonly operationalStatus: string | null;
  readonly physicalCondition: string | null;
}

export interface MovementSignedFields {
  readonly assetId: string;
  readonly movementType: string;
  readonly executedAt: Date;
  readonly requestedBy: string | null;
  readonly authorizedBy: string | null;
  readonly from: MovementStateSnapshot;
  readonly to: MovementStateSnapshot;
  readonly reason: string | null;
  readonly documentReference: string | null;
  readonly loanId: string | null;
  readonly previousMovementId: string | null;
  readonly metadata: Record<string, unknown>;
}

const id = (value: string | null): string | null => value?.toLowerCase() ?? null;

const snapshot = (state: MovementStateSnapshot) => ({
  costCenterId: id(state.costCenterId),
  locationId: id(state.locationId),
  responsibleId: id(state.responsibleId),
  operationalStatus: state.operationalStatus,
  physicalCondition: state.physicalCondition,
});

export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
};

export const canonicalMovementPayload = (fields: MovementSignedFields): string =>
  canonicalJson({
    version: SIGNATURE_VERSION,
    assetId: id(fields.assetId),
    movementType: fields.movementType,
    executedAt: fields.executedAt.toISOString(),
    requestedBy: id(fields.requestedBy),
    authorizedBy: id(fields.authorizedBy),
    from: snapshot(fields.from),
    to: snapshot(fields.to),
    reason: fields.reason,
    documentReference: fields.documentReference,
    loanId: id(fields.loanId),
    previousMovementId: id(fields.previousMovementId),
    metadata: fields.metadata,
  });

export const signMovement = (secret: string, canonical: string): string =>
  createHmac('sha256', secret).update(canonical).digest('hex');
