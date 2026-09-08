import { describe, expect, it } from 'vitest';
import {
  canonicalMovementPayload,
  signMovement,
} from './sign-movement.js';

describe('signMovement', () => {
  it('firma de forma determinista', () => {
    const canonical = canonicalMovementPayload({
      assetId: 'a',
      type: 'REGISTRATION',
      timestamp: '2026-01-01T00:00:00.000Z',
      performedBy: 'u1',
      previousValues: '{}',
      newValues: '{"x":1}',
      previousMovementId: '',
    });
    const first = signMovement('secret', canonical);
    const second = signMovement('secret', canonical);
    expect(first).toBe(second);
    expect(first).toHaveLength(64);
  });

  it('cambia si se altera el payload', () => {
    const left = signMovement(
      'secret',
      canonicalMovementPayload({
        assetId: 'a',
        type: 'REGISTRATION',
        timestamp: '2026-01-01T00:00:00.000Z',
        performedBy: 'u1',
        previousValues: '{}',
        newValues: '{}',
        previousMovementId: '',
      }),
    );
    const right = signMovement(
      'secret',
      canonicalMovementPayload({
        assetId: 'b',
        type: 'REGISTRATION',
        timestamp: '2026-01-01T00:00:00.000Z',
        performedBy: 'u1',
        previousValues: '{}',
        newValues: '{}',
        previousMovementId: '',
      }),
    );
    expect(left).not.toBe(right);
  });
});
