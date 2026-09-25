import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * MFA desde sesión, códigos de recuperación y reset administrativo.
 *
 * - app_user.mfa_pending_secret / mfa_pending_created_at: secreto TOTP en enrolamiento. No reemplaza a mfa_secret
 *   hasta que el usuario confirma con un código del nuevo secreto.
 * - app_user.mfa_enrollment_required: el siguiente login exige enrolar (flujo de setup existente) aunque el rol no
 *   lo exija. Lo activa el reset administrativo.
 * - refresh_token_family.mfa_verified_at: la sesión se abrió (o se elevó) con segundo factor. NULL en sesiones
 *   abiertas solo con contraseña y en todas las existentes al migrar.
 * - mfa_recovery_code: hash argon2id de cada código de un solo uso; nunca el código.
 */
export class MfaRecovery1767225660000 implements MigrationInterface {
  name = 'MfaRecovery1767225660000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE app_user
        ADD COLUMN mfa_pending_secret TEXT,
        ADD COLUMN mfa_pending_created_at TIMESTAMPTZ,
        ADD COLUMN mfa_enrollment_required BOOLEAN NOT NULL DEFAULT FALSE,
        ADD CONSTRAINT chk_app_user_mfa_pending CHECK ((mfa_pending_secret IS NULL) = (mfa_pending_created_at IS NULL))
    `);
    await queryRunner.query('ALTER TABLE refresh_token_family ADD COLUMN mfa_verified_at TIMESTAMPTZ');
    await queryRunner.query(`
      CREATE TABLE mfa_recovery_code (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
        code_hash   TEXT NOT NULL,
        used_at     TIMESTAMPTZ,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_mfa_recovery_code_user_unused ON mfa_recovery_code (user_id) WHERE used_at IS NULL',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [row] = (await queryRunner.query(
      'SELECT count(*)::int AS pending FROM app_user WHERE mfa_enrollment_required',
    )) as Array<{ pending: number }>;
    if (row && row.pending > 0) {
      throw new Error(
        `No se puede revertir: ${row.pending} usuarios tienen un reset de MFA pendiente de enrolar y entrarían sin segundo factor`,
      );
    }
    await queryRunner.query('DROP TABLE mfa_recovery_code');
    await queryRunner.query('ALTER TABLE refresh_token_family DROP COLUMN mfa_verified_at');
    await queryRunner.query(`
      ALTER TABLE app_user
        DROP CONSTRAINT chk_app_user_mfa_pending,
        DROP COLUMN mfa_enrollment_required,
        DROP COLUMN mfa_pending_created_at,
        DROP COLUMN mfa_pending_secret
    `);
  }
}
