import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AuthLockoutIpFactors1767226130000 implements MigrationInterface {
  name = 'AuthLockoutIpFactors1767226130000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE auth_attempt_lockout DROP CONSTRAINT chk_auth_attempt_lockout_factor',
    );
    await queryRunner.query(
      'ALTER TABLE auth_attempt_lockout ALTER COLUMN factor TYPE VARCHAR(20)',
    );
    await queryRunner.query(`
      ALTER TABLE auth_attempt_lockout
      ADD CONSTRAINT chk_auth_attempt_lockout_factor
      CHECK (factor IN ('PASSWORD', 'MFA', 'PASSWORD_IP', 'IP_FAILURES'))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "DELETE FROM auth_attempt_lockout WHERE factor IN ('PASSWORD_IP', 'IP_FAILURES')",
    );
    await queryRunner.query(
      'ALTER TABLE auth_attempt_lockout DROP CONSTRAINT chk_auth_attempt_lockout_factor',
    );
    await queryRunner.query(
      'ALTER TABLE auth_attempt_lockout ALTER COLUMN factor TYPE VARCHAR(10)',
    );
    await queryRunner.query(`
      ALTER TABLE auth_attempt_lockout
      ADD CONSTRAINT chk_auth_attempt_lockout_factor
      CHECK (factor IN ('PASSWORD', 'MFA'))
    `);
  }
}
