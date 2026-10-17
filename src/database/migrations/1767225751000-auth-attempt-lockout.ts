import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AuthAttemptLockout1767225751000 implements MigrationInterface {
  name = 'AuthAttemptLockout1767225751000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE auth_attempt_lockout (
        subject            VARCHAR(80) NOT NULL,
        factor             VARCHAR(10) NOT NULL,
        failed_count       INTEGER NOT NULL DEFAULT 0,
        window_started_at  TIMESTAMPTZ NOT NULL,
        lock_level         INTEGER NOT NULL DEFAULT 0,
        locked_until       TIMESTAMPTZ,
        last_failure_at    TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (subject, factor),
        CONSTRAINT chk_auth_attempt_lockout_factor CHECK (factor IN ('PASSWORD', 'MFA')),
        CONSTRAINT chk_auth_attempt_lockout_counts CHECK (failed_count >= 0 AND lock_level >= 0)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_auth_attempt_lockout_last_failure ON auth_attempt_lockout (last_failure_at)',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE auth_attempt_lockout');
  }
}
