import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Plantillas Excel de importación (src/modules/staging/templates/import-template.ts):
 *
 * - import_template: historial de cada archivo generado. version = identificador de la definición de campos
 *   (cambia solo si cambia la definición); content_hash = definición + catálogos (un archivo por contenido). El
 *   archivo vive en el storage del sistema (storage_driver, storage_key) y se sirve desde ahí; se regenera solo
 *   cuando aparece un content_hash nuevo.
 * - staging_import.template_version: versión de la plantilla detectada en el archivo subido (NULL si el archivo no
 *   viene de una plantilla). Texto, sin FK: un archivo descargado en otro entorno trae una versión válida aunque
 *   este entorno no la haya generado.
 * - staging_import.template_example_rows: filas del archivo idénticas a la fila de ejemplo de la plantilla; la
 *   clasificación las ignora.
 *
 * Aditiva: down() borra la tabla y las columnas nuevas.
 */
export class ImportTemplates1767225710000 implements MigrationInterface {
  name = 'ImportTemplates1767225710000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE import_template (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        target           VARCHAR(20) NOT NULL,
        version          VARCHAR(40) NOT NULL,
        definition_hash  CHAR(64) NOT NULL,
        content_hash     CHAR(64) NOT NULL,
        file_name        VARCHAR(200) NOT NULL,
        storage_driver   VARCHAR(20) NOT NULL,
        storage_key      TEXT NOT NULL,
        byte_size        INTEGER NOT NULL,
        checksum_sha256  CHAR(64) NOT NULL,
        generated_by     UUID REFERENCES app_user(id),
        generated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_import_template_target CHECK (target IN ('ASSETS', 'COST_CENTERS', 'PERSONS'))
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_import_template_content ON import_template (target, content_hash, generated_at DESC)',
    );
    await queryRunner.query('CREATE INDEX idx_import_template_version ON import_template (version, generated_at)');
    await queryRunner.query(`
      ALTER TABLE staging_import
        ADD COLUMN template_version VARCHAR(40),
        ADD COLUMN template_example_rows INTEGER[] NOT NULL DEFAULT '{}'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE staging_import
        DROP COLUMN template_example_rows,
        DROP COLUMN template_version
    `);
    await queryRunner.query('DROP TABLE import_template');
  }
}
