import type { MigrationInterface, QueryRunner } from 'typeorm';


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
