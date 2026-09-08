import { describe, expect, it } from 'vitest';
import { canTransitionStatus } from './status-transitions.js';
import { OperationalStatus } from '../enums/operational-status.enum.js';

describe('canTransitionStatus', () => {
  it('permite IN_USE a IN_MAINTENANCE y bloquea WRITTEN_OFF', () => {
    expect(
      canTransitionStatus(
        OperationalStatus.InUse,
        OperationalStatus.InMaintenance,
      ),
    ).toBe(true);
    expect(
      canTransitionStatus(
        OperationalStatus.InUse,
        OperationalStatus.WrittenOff,
      ),
    ).toBe(false);
    expect(
      canTransitionStatus(
        OperationalStatus.WrittenOff,
        OperationalStatus.InUse,
      ),
    ).toBe(false);
  });
});
