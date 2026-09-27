import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * - app_user.invitation_expires_at (BE-14): vencimiento de la contraseña temporal de una invitación (72 h desde el
 *   envío o el reenvío; ver src/modules/auth/services/invitation-policy.ts). NULL = la cuenta no tiene contraseña
 *   temporal. Las invitaciones vivas al aplicar la migración (must_change_password = TRUE) reciben 72 h desde ahora:
 *   no se cortan de golpe, pero dejan de ser eternas.
 * - app_user.mfa_last_totp_step (BE-11): último paso de tiempo TOTP (RFC 6238, floor(epoch / 30)) aceptado para el
 *   usuario. Un código de ese paso o de uno anterior se rechaza: el mismo código no sirve dos veces.
 */
export class InvitationExpiryAndTotpStep1767225770000 implements MigrationInterface {
  name = 'InvitationExpiryAndTotpStep1767225770000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE app_user
        ADD COLUMN invitation_expires_at TIMESTAMPTZ,
        ADD COLUMN mfa_last_totp_step BIGINT,
        ADD CONSTRAINT chk_app_user_mfa_last_totp_step CHECK (mfa_last_totp_step IS NULL OR mfa_last_totp_step >= 0)
    `);
    await queryRunner.query(`
      UPDATE app_user
      SET invitation_expires_at = NOW() + interval '72 hours'
      WHERE must_change_password = TRUE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE app_user
        DROP CONSTRAINT chk_app_user_mfa_last_totp_step,
        DROP COLUMN mfa_last_totp_step,
        DROP COLUMN invitation_expires_at
    `);
  }
}
