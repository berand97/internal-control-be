import type { MigrationInterface, QueryRunner } from 'typeorm';

export class MailSettingsEncryptedText1767225620000 implements MigrationInterface {
  name = 'MailSettingsEncryptedText1767225620000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE mail_settings
        ALTER COLUMN host TYPE TEXT,
        ALTER COLUMN from_name TYPE TEXT,
        ALTER COLUMN from_email TYPE TEXT
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE mail_settings
        ALTER COLUMN host TYPE VARCHAR(255),
        ALTER COLUMN from_name TYPE VARCHAR(150),
        ALTER COLUMN from_email TYPE VARCHAR(255)
    `);
  }
}
