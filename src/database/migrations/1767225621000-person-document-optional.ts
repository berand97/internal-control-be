import type { MigrationInterface, QueryRunner } from 'typeorm';

export class PersonDocumentOptional1767225621000 implements MigrationInterface {
  name = 'PersonDocumentOptional1767225621000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE person
        ALTER COLUMN document_type DROP NOT NULL,
        ALTER COLUMN document_number DROP NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE person
      SET document_type = 'CC', document_number = id::text
      WHERE document_type IS NULL OR document_number IS NULL
    `);
    await queryRunner.query(`
      ALTER TABLE person
        ALTER COLUMN document_type SET NOT NULL,
        ALTER COLUMN document_number SET NOT NULL
    `);
  }
}
