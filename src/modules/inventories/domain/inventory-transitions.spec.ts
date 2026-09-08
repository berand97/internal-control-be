import { describe, expect, it } from 'vitest';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { InventoryStatus } from '../enums/inventory-status.js';
import {
  assertInventoryTransition,
  exceedsUnverifiedThreshold,
} from './inventory-transitions.js';

describe('inventory-transitions', () => {
  it('permite PLANNED → IN_PROGRESS y bloquea RECONCILED desde PLANNED', () => {
    expect(() =>
      assertInventoryTransition(
        InventoryStatus.Planned,
        InventoryStatus.InProgress,
      ),
    ).not.toThrow();
    expect(() =>
      assertInventoryTransition(
        InventoryStatus.Planned,
        InventoryStatus.Reconciled,
      ),
    ).toThrowError();
  });

  it('exige autorización si más del 5% está pendiente', () => {
    expect(exceedsUnverifiedThreshold(0, 100)).toBe(false);
    expect(exceedsUnverifiedThreshold(5, 100)).toBe(false);
    expect(exceedsUnverifiedThreshold(6, 100)).toBe(true);
    expect(exceedsUnverifiedThreshold(1, 10)).toBe(true);
  });

  it('usa InvalidState en transiciones ilegales', () => {
    try {
      assertInventoryTransition(
        InventoryStatus.Closed,
        InventoryStatus.InProgress,
      );
      throw new Error('expected');
    } catch (error) {
      expect(error).toMatchObject({ code: ErrorCode.InvalidState });
    }
  });
});
