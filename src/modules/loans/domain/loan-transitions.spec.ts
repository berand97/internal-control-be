import { describe, expect, it } from 'vitest';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { assertLoanTransition } from './loan-transitions.js';

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
});
