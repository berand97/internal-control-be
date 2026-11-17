import type { MigrationInterface, QueryRunner } from 'typeorm';

export class DocumentTemplateSameDay1767226180000 implements MigrationInterface {
  name = 'DocumentTemplateSameDay1767226180000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE document_template_version DROP CONSTRAINT IF EXISTS uq_document_template_version',
    );
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_document_template_version_active
        ON document_template_version (format_key, effective_date DESC, uploaded_at DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS idx_document_template_version_active');
    await queryRunner.query(`
      DELETE FROM document_template_version a
      USING document_template_version b
      WHERE a.format_key = b.format_key
        AND a.effective_date = b.effective_date
        AND a.uploaded_at < b.uploaded_at
    `);
    await queryRunner.query(`
      ALTER TABLE document_template_version
        ADD CONSTRAINT uq_document_template_version UNIQUE (format_key, effective_date)
    `);
  }
}
