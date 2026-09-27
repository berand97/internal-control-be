import { describe, expect, it } from 'vitest';
import {
  countAttempt,
  isLocked,
  LOCKOUT_POLICIES,
  type LockoutState,
} from './auth-lockout.policy.js';

const MINUTE = 60_000;
const policy = LOCKOUT_POLICIES.PASSWORD;

const failTimes = (
  start: LockoutState | null,
  times: number,
  at: Date,
): { state: LockoutState | null; lockedNow: boolean } => {
  let state = start;
  let lockedNow = false;
  for (let index = 0; index < times; index += 1) {
    const result = countAttempt(state, policy, at);
    state = result.next;
    lockedNow = result.lockedNow;
  }
  return { state, lockedNow };
};

describe('auth-lockout.policy', () => {
  const t0 = new Date('2026-09-26T12:00:00Z');

  it('bloquea al quinto intento dentro de la ventana, por 15 minutos', () => {
    const four = failTimes(null, 4, t0);
    expect(four.lockedNow).toBe(false);
    expect(isLocked(four.state, t0)).toBe(false);
    const fifth = countAttempt(four.state, policy, t0);
    expect(fifth.lockedNow).toBe(true);
    expect(fifth.next.lockedUntil?.getTime()).toBe(t0.getTime() + 15 * MINUTE);
    expect(isLocked(fifth.next, new Date(t0.getTime() + 14 * MINUTE))).toBe(true);
    expect(isLocked(fifth.next, new Date(t0.getTime() + 15 * MINUTE))).toBe(false);
  });

  it('los fallos fuera de la ventana no se acumulan', () => {
    const four = failTimes(null, 4, t0);
    const later = new Date(t0.getTime() + 16 * MINUTE);
    const next = countAttempt(four.state, policy, later);
    expect(next.lockedNow).toBe(false);
    expect(next.next.failedCount).toBe(1);
  });

  it('dobla la duración en bloqueos seguidos, con tope de 60 minutos', () => {
    let state: LockoutState | null = null;
    let at = t0;
    const durations: number[] = [];
    for (let lock = 0; lock < 4; lock += 1) {
      const result = failTimes(state, 5, at);
      state = result.state;
      const until = state?.lockedUntil?.getTime() ?? 0;
      durations.push((until - at.getTime()) / MINUTE);
      at = new Date(until);
    }
    expect(durations).toEqual([15, 30, 60, 60]);
  });

  it('olvida el escalón tras 24 h sin fallos', () => {
    const locked = failTimes(null, 5, t0).state;
    const dayLater = new Date(t0.getTime() + 25 * 60 * MINUTE);
    const again = failTimes(locked, 5, dayLater).state;
    expect((again?.lockedUntil?.getTime() ?? 0) - dayLater.getTime()).toBe(15 * MINUTE);
  });

  it('MFA tiene tope de 4 h', () => {
    expect(LOCKOUT_POLICIES.MFA.maxLockMs).toBe(4 * 60 * MINUTE);
    expect(LOCKOUT_POLICIES.MFA.threshold).toBe(5);
  });
});
