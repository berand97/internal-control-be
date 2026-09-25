import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  canonicalMovementPayload,
  type MovementSignedFields,
  signMovement,
} from './sign-movement.js';

const empty = {
  costCenterId: null,
  locationId: null,
  responsibleId: null,
  operationalStatus: null,
  physicalCondition: null,
};

const fields = (overrides: Partial<MovementSignedFields> = {}): MovementSignedFields => ({
  assetId: 'a1b2c3d4-0000-4000-8000-000000000001',
  movementType: 'REGISTRATION',
  executedAt: new Date('2026-01-01T00:00:00.000Z'),
  requestedBy: null,
  authorizedBy: null,
  from: empty,
  to: { ...empty, operationalStatus: 'IN_USE' },
  reason: 'Alta',
  documentReference: null,
  loanId: null,
  previousMovementId: null,
  metadata: { signedAt: '2026-01-01T00:00:00.000Z', signatureVersion: 2 },
  ...overrides,
});

const sign = (overrides: Partial<MovementSignedFields> = {}) =>
  signMovement('secret', canonicalMovementPayload(fields(overrides)));

describe('signMovement', () => {
  it('firma de forma determinista', () => {
    expect(sign()).toBe(sign());
    expect(sign()).toHaveLength(64);
  });

  it('cambia si se altera executedAt, reason o documentReference', () => {
    expect(sign({ executedAt: new Date('2019-01-01T00:00:00.000Z') })).not.toBe(sign());
    expect(sign({ reason: 'Otra cosa' })).not.toBe(sign());
    expect(sign({ documentReference: 'ACTA-1' })).not.toBe(sign());
  });

  it('no depende del orden de las claves de metadata ni de mayúsculas en UUID', () => {
    const reordered = sign({
      metadata: { signatureVersion: 2, signedAt: '2026-01-01T00:00:00.000Z' },
      assetId: 'A1B2C3D4-0000-4000-8000-000000000001',
    });
    expect(reordered).toBe(sign());
  });

  it('distingue un separador dentro de un campo', () => {
    expect(sign({ reason: 'a|b', documentReference: 'c' })).not.toBe(
      sign({ reason: 'a', documentReference: 'b|c' }),
    );
  });
});

describe('canonicalJson', () => {
  it('ordena claves anidadas y omite undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [2, { z: 1, y: 0 }] } })).toBe(
      '{"a":{"c":[2,{"y":0,"z":1}]},"b":1}',
    );
  });
});
