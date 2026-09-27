import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Bloqueo temporal por cuenta ante intentos fallidos de autenticación (hallazgo BE-04).
 *
 * Una fila por (sujeto, factor):
 * - subject: 'user:<uuid>' para cuentas existentes; 'id:<sha256 hex>' del identificador normalizado cuando la
 *   cuenta no existe, para que una cuenta inexistente se comporte igual que una real (sin enumeración). Nunca se
 *   guarda la contraseña, el código ni el identificador en claro.
 * - factor: PASSWORD (POST /auth/login) o MFA (TOTP y códigos de recuperación del desafío).
 * - failed_count / window_started_at: fallos dentro de la ventana vigente.
 * - lock_level: bloqueos consecutivos (duración con backoff); se olvida tras un periodo sin fallos.
 * - locked_until: fin del bloqueo temporal. Nunca es permanente.
 * Los valores (umbral, ventana, duración y tope) viven en src/modules/auth/services/auth-lockout.policy.ts.
 */
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
