import { createHmac } from 'node:crypto';

export interface MovementCanonicalInput {
  readonly assetId: string;
  readonly type: string;
  readonly timestamp: string;
  readonly performedBy: string;
  readonly previousValues: string;
  readonly newValues: string;
  readonly previousMovementId: string;
}

export const canonicalMovementPayload = (
  input: MovementCanonicalInput,
): string =>
  [
    input.assetId,
    input.type,
    input.timestamp,
    input.performedBy,
    input.previousValues,
    input.newValues,
    input.previousMovementId,
  ].join('|');

export const signMovement = (secret: string, canonical: string): string =>
  createHmac('sha256', secret).update(canonical).digest('hex');

export const stableJson = (value: unknown): string => JSON.stringify(value);
