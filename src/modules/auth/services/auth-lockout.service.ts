import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import {
  countAttempt,
  isLocked,
  LOCKOUT_POLICIES,
  type AuthFactor,
  type LockoutState,
} from './auth-lockout.policy.js';

interface LockoutRow {
  readonly failed_count: number;
  readonly window_started_at: Date;
  readonly lock_level: number;
  readonly locked_until: Date | null;
  readonly last_failure_at: Date;
}

export interface AttemptOutcome {
  /** false: el sujeto está bloqueado; no se debe verificar la credencial. */
  readonly allowed: boolean;
  /** Este intento alcanzó el umbral: si resulta fallido, queda bloqueado hasta `lockedUntil`. */
  readonly lockedNow: boolean;
  readonly lockedUntil: Date | null;
}

/** Filas sin fallos en este lapso y sin bloqueo vigente se borran (no se acumulan identificadores inventados). */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Contador persistente de intentos por cuenta (auth_attempt_lockout). Cada intento se cuenta ANTES de verificar la
 * credencial, dentro de una transacción con la fila bloqueada (FOR UPDATE): peticiones concurrentes desde muchas IP
 * no superan el umbral. Un acierto borra la fila (clear).
 */
@Injectable()
export class AuthLockoutService {
  constructor(private readonly dataSource: DataSource) {}

  static subjectForUser(userId: string): string {
    return `user:${userId}`;
  }

  /**
   * Identificador sin cuenta: se cuenta igual que una cuenta real para que el bloqueo no delate cuáles existen. Solo
   * se guarda un hash del identificador normalizado, nunca el texto.
   */
  static subjectForUnknownIdentifier(identifier: string): string {
    const digest = createHash('sha256')
      .update(`auth-lockout:${identifier.trim().toLowerCase()}`)
      .digest('hex');
    return `id:${digest}`;
  }

  async registerAttempt(
    subject: string,
    factor: AuthFactor,
    now: Date = new Date(),
  ): Promise<AttemptOutcome> {
    const outcome = await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO auth_attempt_lockout (subject, factor, failed_count, window_started_at, lock_level, last_failure_at)
         VALUES ($1, $2, 0, $3, 0, $3)
         ON CONFLICT (subject, factor) DO NOTHING`,
        [subject, factor, now],
      );
      const rows = (await manager.query(
        `SELECT failed_count, window_started_at, lock_level, locked_until, last_failure_at
         FROM auth_attempt_lockout
         WHERE subject = $1 AND factor = $2
         FOR UPDATE`,
        [subject, factor],
      )) as LockoutRow[];
      const row = rows[0];
      const state: LockoutState | null = row
        ? {
            failedCount: row.failed_count,
            windowStartedAt: new Date(row.window_started_at),
            lockLevel: row.lock_level,
            lockedUntil: row.locked_until ? new Date(row.locked_until) : null,
            lastFailureAt: new Date(row.last_failure_at),
          }
        : null;
      if (isLocked(state, now)) {
        return {
          allowed: false,
          lockedNow: false,
          lockedUntil: state?.lockedUntil ?? null,
        };
      }
      const { next, lockedNow } = countAttempt(
        state,
        LOCKOUT_POLICIES[factor],
        now,
      );
      await manager.query(
        `UPDATE auth_attempt_lockout
         SET failed_count = $3, window_started_at = $4, lock_level = $5, locked_until = $6, last_failure_at = $7
         WHERE subject = $1 AND factor = $2`,
        [
          subject,
          factor,
          next.failedCount,
          next.windowStartedAt,
          next.lockLevel,
          next.lockedUntil,
          next.lastFailureAt,
        ],
      );
      return { allowed: true, lockedNow, lockedUntil: next.lockedUntil };
    });
    await this.purgeStale(now);
    return outcome;
  }

  async clear(subject: string, factor: AuthFactor): Promise<void> {
    await this.dataSource.query(
      'DELETE FROM auth_attempt_lockout WHERE subject = $1 AND factor = $2',
      [subject, factor],
    );
  }

  private async purgeStale(now: Date): Promise<void> {
    await this.dataSource.query(
      `DELETE FROM auth_attempt_lockout
       WHERE last_failure_at < $1
         AND (locked_until IS NULL OR locked_until < $2)`,
      [new Date(now.getTime() - STALE_AFTER_MS), now],
    );
  }
}
