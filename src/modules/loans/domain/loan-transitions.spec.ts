import { describe, expect, it } from 'vitest';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { assertLoanTransition, canTransition, statusAfterReception } from './loan-transitions.js';

describe('assertLoanTransition', () => {
  it('permite solicitar → aprobar', () => {
    expect(() => assertLoanTransition('REQUESTED', 'APPROVED')).not.toThrow();
  });

  it('rechaza devolver un préstamo ya cerrado', () => {
    try {
      assertLoanTransition('RETURNED', 'ACTIVE');
      throw new Error('expected');
    } catch (error) {
      expect(error).toMatchObject({ code: ErrorCode.InvalidLoanStateTransition });
    }
  });

  it('la entrega deja el préstamo pendiente de firmas; solo la firma lo activa', () => {
    expect(canTransition('APPROVED', 'PENDING_SIGNATURES')).toBe(true);
    expect(canTransition('APPROVED', 'ACTIVE')).toBe(false);
    expect(canTransition('PENDING_SIGNATURES', 'ACTIVE')).toBe(true);
    expect(canTransition('PENDING_SIGNATURES', 'CANCELLED')).toBe(true);
    expect(canTransition('PENDING_SIGNATURES', 'PENDING_RECEPTION')).toBe(false);
  });

  it('un préstamo parcialmente devuelto sigue abierto; los cerrados no', () => {
    expect(canTransition('PARTIALLY_RETURNED', 'PENDING_RECEPTION')).toBe(true);
    expect(canTransition('CLOSED_WITH_LOSSES', 'PENDING_RECEPTION')).toBe(false);
    expect(canTransition('RETURNED', 'PENDING_RECEPTION')).toBe(false);
  });
});

describe('statusAfterReception', () => {
  it('alguno fuera → PARTIALLY_RETURNED; todos resueltos con pérdida → CLOSED_WITH_LOSSES; si no → RETURNED', () => {
    expect(statusAfterReception([{ received: true, lost: false }, { received: false, lost: false }])).toBe('PARTIALLY_RETURNED');
    expect(statusAfterReception([{ received: true, lost: true }, { received: false, lost: false }])).toBe('PARTIALLY_RETURNED');
    expect(statusAfterReception([{ received: true, lost: true }, { received: true, lost: false }])).toBe('CLOSED_WITH_LOSSES');
    expect(statusAfterReception([{ received: true, lost: false }])).toBe('RETURNED');
  });
});
