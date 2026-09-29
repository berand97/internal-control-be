import { describe, expect, it } from 'vitest';
import {
  ASSET_REQUEST_STATUSES,
  assertAssetRequestTransition,
  canAssetRequestTransition,
  statusAfterCorrection,
} from './asset-request.js';

describe('asset-request transitions', () => {
  it('permite exactamente el flujo acordado', () => {
    const allowed = ASSET_REQUEST_STATUSES.flatMap((from) =>
      ASSET_REQUEST_STATUSES.filter((to) => canAssetRequestTransition(from, to)).map((to) => `${from}->${to}`),
    );
    expect(allowed.sort()).toEqual(
      [
        'REQUESTED->ACCEPTED',
        'REQUESTED->CLOSED_BY_OWNER',
        'REQUESTED->CANCELLED',
        'ACCEPTED->LOAN_SCHEDULED',
        'ACCEPTED->DOCUMENT_GENERATED',
        'LOAN_SCHEDULED->DOCUMENT_GENERATED',
        'ACCEPTED->RETURNED',
        'ACCEPTED->EXPIRED',
        'RETURNED->REQUESTED',
        'RETURNED->ACCEPTED',
        'RETURNED->CANCELLED',
        'RETURNED->EXPIRED',
      ].sort(),
    );
  });

  it('los finales no salen a ninguna parte', () => {
    for (const final of ['CLOSED_BY_OWNER', 'DOCUMENT_GENERATED', 'CANCELLED', 'EXPIRED'] as const) {
      expect(ASSET_REQUEST_STATUSES.some((to) => canAssetRequestTransition(final, to))).toBe(false);
    }
  });

  it('una transición no permitida lanza ASSET_REQUEST_INVALID_STATE_TRANSITION', () => {
    expect(() => assertAssetRequestTransition('ACCEPTED', 'CANCELLED')).toThrow();
    expect(() => assertAssetRequestTransition('REQUESTED', 'ACCEPTED')).not.toThrow();
  });

  it('la corrección vuelve al dueño si cambia lo que él decidió; si no, a Control Interno', () => {
    const none = { ownerCostCenter: false, kind: false, requestingCostCenter: false };
    expect(statusAfterCorrection(none)).toBe('ACCEPTED');
    expect(statusAfterCorrection({ ...none, kind: true })).toBe('REQUESTED');
    expect(statusAfterCorrection({ ...none, ownerCostCenter: true })).toBe('REQUESTED');
    expect(statusAfterCorrection({ ...none, requestingCostCenter: true })).toBe('REQUESTED');
  });
});
