import type { MigrationInterface, QueryRunner } from 'typeorm';

const PREVIOUS_FLAGS = [
  'BARCODE_TEMP',
  'BARCODE_DUPLICATED',
  'ACQUISITION_DATE_MISSING',
  'ACQUISITION_DATE_INVALID',
  'PHOTO_MISSING',
];

const ADDED_FLAGS = [
  'BARCODE_EMPTY',
  'PRICE_ZERO',
  'PRICE_MISSING',
  'CATEGORY_UNASSIGNED',
  'ACQUISITION_TYPE_UNKNOWN',
  'PHYSICAL_CONDITION_UNKNOWN',
  'COST_CENTER_NOT_IN_CATALOG',
];

const PREVIOUS_KINDS = ['ASSET_REPORT', 'COST_CENTERS', 'EMPLOYEE_CONTRACTS'];

const list = (values: ReadonlyArray<string>): string => values.map((value) => `'${value}'`).join(', ');

export class ExcelImport1767225627000 implements MigrationInterface {
  name = 'ExcelImport1767225627000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE staging_batch DROP CONSTRAINT chk_staging_batch_kind');
    await queryRunner.query(`
      ALTER TABLE staging_batch ADD CONSTRAINT chk_staging_batch_kind
        CHECK (source_kind IN (${list([...PREVIOUS_KINDS, 'UPLOAD'])}))
    `);
    await queryRunner.query(`
      CREATE TABLE staging_import (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        batch_id      UUID NOT NULL REFERENCES staging_batch(id) ON DELETE CASCADE,
        sheet_name    VARCHAR(100) NOT NULL,
        header_row    INTEGER NOT NULL,
        target        VARCHAR(20) NOT NULL,
        mapping       JSONB NOT NULL,
        options       JSONB NOT NULL DEFAULT '{}',
        status        VARCHAR(20) NOT NULL DEFAULT 'PREVIEWED',
        preview       JSONB,
        result        JSONB,
        created_by    UUID REFERENCES app_user(id),
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        confirmed_at  TIMESTAMPTZ,
        CONSTRAINT chk_staging_import_target CHECK (target IN ('ASSETS', 'COST_CENTERS')),
        CONSTRAINT chk_staging_import_status CHECK (status IN ('PREVIEWED', 'CONFIRMED'))
      )
    `);
    await queryRunner.query(`
      ALTER TABLE staging_issue
        ADD COLUMN import_id UUID REFERENCES staging_import(id) ON DELETE CASCADE
    `);
    await queryRunner.query('CREATE INDEX idx_staging_issue_import ON staging_issue (import_id, row_number)');
    await queryRunner.query(`
      CREATE TABLE asset_import_origin (
        asset_id          UUID PRIMARY KEY REFERENCES asset(id),
        legacy_asset_id   VARCHAR(30) NOT NULL,
        import_id         UUID REFERENCES staging_import(id) ON DELETE SET NULL,
        source_file       VARCHAR(255) NOT NULL,
        sheet_name        VARCHAR(100) NOT NULL,
        row_number        INTEGER NOT NULL,
        source_row        JSONB NOT NULL,
        imported_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_asset_import_origin_legacy UNIQUE (legacy_asset_id)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE staging_quarantine (
        id               BIGSERIAL PRIMARY KEY,
        import_id        UUID NOT NULL REFERENCES staging_import(id) ON DELETE CASCADE,
        sheet_name       VARCHAR(100) NOT NULL,
        row_number       INTEGER NOT NULL,
        legacy_asset_id  VARCHAR(30),
        reason           VARCHAR(40) NOT NULL,
        detail           TEXT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_staging_quarantine_row UNIQUE (import_id, row_number, reason)
      )
    `);
    await queryRunner.query('ALTER TABLE asset DROP CONSTRAINT chk_asset_data_quality_flags');
    await queryRunner.query(`
      ALTER TABLE asset ADD CONSTRAINT chk_asset_data_quality_flags
        CHECK (data_quality_flags <@ ARRAY[${list([...PREVIOUS_FLAGS, ...ADDED_FLAGS])}]::VARCHAR(40)[])
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [row] = (await queryRunner.query(`
      SELECT
        (SELECT count(*) FROM staging_import)::int AS imports,
        (SELECT count(*) FROM asset_import_origin)::int AS imported,
        (SELECT count(*) FROM staging_batch WHERE source_kind = 'UPLOAD')::int AS uploads,
        (SELECT count(*) FROM asset
          WHERE data_quality_flags && ARRAY[${list(ADDED_FLAGS)}]::VARCHAR(40)[])::int AS flagged
    `)) as Array<{ imports: number; imported: number; uploads: number; flagged: number }>;
    if (row && (row.imports > 0 || row.imported > 0 || row.uploads > 0 || row.flagged > 0)) {
      throw new Error(
        `No se puede revertir sin perder datos: ${row.imports} importaciones, ${row.imported} activos importados, ` +
          `${row.uploads} archivos subidos, ${row.flagged} activos con banderas nuevas`,
      );
    }
    await queryRunner.query('ALTER TABLE asset DROP CONSTRAINT chk_asset_data_quality_flags');
    await queryRunner.query(`
      ALTER TABLE asset ADD CONSTRAINT chk_asset_data_quality_flags
        CHECK (data_quality_flags <@ ARRAY[${list(PREVIOUS_FLAGS)}]::VARCHAR(40)[])
    `);
    await queryRunner.query('DROP TABLE staging_quarantine');
    await queryRunner.query('DROP TABLE asset_import_origin');
    await queryRunner.query('ALTER TABLE staging_issue DROP COLUMN import_id');
    await queryRunner.query('DROP TABLE staging_import');
    await queryRunner.query('ALTER TABLE staging_batch DROP CONSTRAINT chk_staging_batch_kind');
    await queryRunner.query(`
      ALTER TABLE staging_batch ADD CONSTRAINT chk_staging_batch_kind
        CHECK (source_kind IN (${list(PREVIOUS_KINDS)}))
    `);
  }
}
