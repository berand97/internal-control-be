import type { MigrationInterface, QueryRunner } from 'typeorm';

export class UserInvitationTempPassword1767225611000 implements MigrationInterface {
  name = 'UserInvitationTempPassword1767225611000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE app_user
        ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE app_user
        DROP COLUMN IF EXISTS must_change_password
    `);
  }
}
