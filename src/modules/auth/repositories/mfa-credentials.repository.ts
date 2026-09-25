import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import type {
  MfaCredentialsRepository,
  MfaPendingEnrollment,
  StoredRecoveryCode,
} from './mfa-credentials.repository.interface.js';

@Injectable()
export class TypeOrmMfaCredentialsRepository implements MfaCredentialsRepository {
  constructor(private readonly dataSource: DataSource) {}

  async lockUser(userId: string, manager: EntityManager): Promise<void> {
    await manager.query('SELECT id FROM app_user WHERE id = $1 FOR UPDATE', [
      userId,
    ]);
  }

  async findPending(
    userId: string,
    manager?: EntityManager,
  ): Promise<MfaPendingEnrollment | null> {
    const [row] = (await (manager ?? this.dataSource).query(
      `SELECT mfa_pending_secret AS secret, mfa_pending_created_at AS created_at
       FROM app_user WHERE id = $1 AND mfa_pending_secret IS NOT NULL`,
      [userId],
    )) as Array<{ secret: string; created_at: Date }>;
    return row ? { secret: row.secret, createdAt: row.created_at } : null;
  }

  async savePending(userId: string, secret: string, at: Date): Promise<void> {
    await this.dataSource.query(
      `UPDATE app_user SET mfa_pending_secret = $2, mfa_pending_created_at = $3 WHERE id = $1`,
      [userId, secret, at],
    );
  }

  async activate(
    userId: string,
    secret: string,
    manager: EntityManager,
  ): Promise<void> {
    await manager.query(
      `UPDATE app_user
       SET mfa_secret = $2, mfa_enabled = TRUE, mfa_pending_secret = NULL,
           mfa_pending_created_at = NULL, mfa_enrollment_required = FALSE
       WHERE id = $1`,
      [userId, secret],
    );
  }

  async clear(
    userId: string,
    enrollmentRequired: boolean,
    manager: EntityManager,
  ): Promise<void> {
    await manager.query(
      `UPDATE app_user
       SET mfa_secret = NULL, mfa_enabled = FALSE, mfa_pending_secret = NULL,
           mfa_pending_created_at = NULL, mfa_enrollment_required = $2
       WHERE id = $1`,
      [userId, enrollmentRequired],
    );
  }

  async replaceRecoveryCodes(
    userId: string,
    codeHashes: ReadonlyArray<string>,
    manager: EntityManager,
  ): Promise<void> {
    await manager.query('DELETE FROM mfa_recovery_code WHERE user_id = $1', [
      userId,
    ]);
    await manager.query(
      `INSERT INTO mfa_recovery_code (user_id, code_hash)
       SELECT $1, hash FROM unnest($2::text[]) AS hash`,
      [userId, [...codeHashes]],
    );
  }

  async deleteRecoveryCodes(
    userId: string,
    manager: EntityManager,
  ): Promise<number> {
    const rows = (await manager.query(
      'DELETE FROM mfa_recovery_code WHERE user_id = $1 RETURNING id',
      [userId],
    )) as [ReadonlyArray<unknown>, number];
    return rows[1];
  }

  async findUnusedRecoveryCodes(
    userId: string,
  ): Promise<ReadonlyArray<StoredRecoveryCode>> {
    const rows = (await this.dataSource.query(
      `SELECT id, code_hash FROM mfa_recovery_code
       WHERE user_id = $1 AND used_at IS NULL ORDER BY created_at, id`,
      [userId],
    )) as Array<{ id: string; code_hash: string }>;
    return rows.map((row) => ({ id: row.id, codeHash: row.code_hash }));
  }

  async consumeRecoveryCode(id: string, at: Date): Promise<boolean> {
    const rows = (await this.dataSource.query(
      `UPDATE mfa_recovery_code SET used_at = $2 WHERE id = $1 AND used_at IS NULL RETURNING id`,
      [id, at],
    )) as [ReadonlyArray<unknown>, number];
    return rows[1] === 1;
  }

  async countUnusedRecoveryCodes(userId: string): Promise<number> {
    const [row] = (await this.dataSource.query(
      'SELECT count(*)::int AS remaining FROM mfa_recovery_code WHERE user_id = $1 AND used_at IS NULL',
      [userId],
    )) as Array<{ remaining: number }>;
    return row?.remaining ?? 0;
  }

  async markSessionMfaVerified(
    userId: string,
    sessionId: string,
    at: Date,
    manager?: EntityManager,
  ): Promise<void> {
    await (manager ?? this.dataSource).query(
      `UPDATE refresh_token_family SET mfa_verified_at = $3
       WHERE id = $2 AND user_id = $1 AND status = 'ACTIVE'`,
      [userId, sessionId, at],
    );
  }

  async isMfaSession(userId: string, sessionId: string): Promise<boolean> {
    const rows = (await this.dataSource.query(
      `SELECT 1 FROM refresh_token_family f
       JOIN app_user u ON u.id = f.user_id
       WHERE f.id = $2 AND f.user_id = $1 AND f.status = 'ACTIVE' AND f.expires_at > NOW()
         AND f.mfa_verified_at IS NOT NULL AND u.mfa_enabled AND u.status = 'ACTIVE'`,
      [userId, sessionId],
    )) as ReadonlyArray<unknown>;
    return rows.length === 1;
  }

  async revokeSessions(
    userId: string,
    keepSessionId: string | null,
    at: Date,
    manager: EntityManager,
  ): Promise<number> {
    const rows = (await manager.query(
      `UPDATE refresh_token_family SET status = 'REVOKED', revoked_at = $2
       WHERE user_id = $1 AND status = 'ACTIVE' AND ($3::uuid IS NULL OR id <> $3::uuid)
       RETURNING id`,
      [userId, at, keepSessionId],
    )) as [ReadonlyArray<unknown>, number];
    return rows[1];
  }
}
