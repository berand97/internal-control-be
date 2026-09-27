/**
 * Bloqueo temporal por cuenta ante intentos fallidos (BE-04). Complementa al throttler por IP (en memoria): este
 * contador vive en la BD (auth_attempt_lockout), así que no se reparte entre IPs ni entre réplicas.
 *
 * PASSWORD (POST /auth/login): 5 intentos dentro de 15 min bloquean 15 min; cada bloqueo seguido dobla la duración
 *   (15 → 30 → 60) con tope de 60 min. Tras 24 h sin fallos el escalón vuelve a cero.
 * MFA (POST /auth/mfa/verify y /auth/mfa/recovery, contador común): 5 intentos dentro de 15 min bloquean 15 min,
 *   doblando hasta 4 h. Quien llega aquí ya tiene la contraseña; con el tope, el ritmo sostenido cae a ~5 intentos
 *   cada 4 h (~30 al día) frente a 10^6 códigos.
 * Ningún bloqueo es permanente, y un inicio correcto borra el contador de ese factor.
 */
export type AuthFactor = 'PASSWORD' | 'MFA';

export interface LockoutPolicy {
  readonly threshold: number;
  readonly windowMs: number;
  readonly baseLockMs: number;
  readonly maxLockMs: number;
  readonly levelResetMs: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const LOCKOUT_POLICIES: Readonly<Record<AuthFactor, LockoutPolicy>> = {
  PASSWORD: {
    threshold: 5,
    windowMs: 15 * MINUTE,
    baseLockMs: 15 * MINUTE,
    maxLockMs: HOUR,
    levelResetMs: 24 * HOUR,
  },
  MFA: {
    threshold: 5,
    windowMs: 15 * MINUTE,
    baseLockMs: 15 * MINUTE,
    maxLockMs: 4 * HOUR,
    levelResetMs: 24 * HOUR,
  },
};

export interface LockoutState {
  readonly failedCount: number;
  readonly windowStartedAt: Date;
  readonly lockLevel: number;
  readonly lockedUntil: Date | null;
  readonly lastFailureAt: Date;
}

export const isLocked = (state: LockoutState | null, now: Date): boolean =>
  state !== null &&
  state.lockedUntil !== null &&
  state.lockedUntil.getTime() > now.getTime();

export const lockDurationMs = (policy: LockoutPolicy, lockLevel: number): number =>
  Math.min(policy.baseLockMs * 2 ** lockLevel, policy.maxLockMs);

/**
 * Estado tras contar un intento más (se cuenta antes de verificar; un acierto borra la fila). `lockedNow` indica
 * que este intento alcanzó el umbral y abrió un bloqueo.
 */
export const countAttempt = (
  state: LockoutState | null,
  policy: LockoutPolicy,
  now: Date,
): { readonly next: LockoutState; readonly lockedNow: boolean } => {
  const at = now.getTime();
  const lockLevel =
    state !== null && at - state.lastFailureAt.getTime() < policy.levelResetMs
      ? state.lockLevel
      : 0;
  const windowActive =
    state !== null && at - state.windowStartedAt.getTime() < policy.windowMs;
  const failedCount = (windowActive ? state.failedCount : 0) + 1;
  const windowStartedAt = windowActive ? state.windowStartedAt : now;
  if (failedCount >= policy.threshold) {
    return {
      next: {
        failedCount: 0,
        windowStartedAt: now,
        lockLevel: lockLevel + 1,
        lockedUntil: new Date(at + lockDurationMs(policy, lockLevel)),
        lastFailureAt: now,
      },
      lockedNow: true,
    };
  }
  return {
    next: {
      failedCount,
      windowStartedAt,
      lockLevel,
      lockedUntil: null,
      lastFailureAt: now,
    },
    lockedNow: false,
  };
};
