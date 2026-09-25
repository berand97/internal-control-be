import type { MigrationInterface, QueryRunner } from 'typeorm';

const FLAGS = [
  'BARCODE_TEMP',
  'BARCODE_DUPLICATED',
  'ACQUISITION_DATE_MISSING',
  'ACQUISITION_DATE_INVALID',
  'PHOTO_MISSING',
];

export class RelaxAssetConstraints1767225625000 implements MigrationInterface {
  name = 'RelaxAssetConstraints1767225625000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE asset
        ADD COLUMN data_quality_flags VARCHAR(40)[] NOT NULL DEFAULT '{}'
    `);
    await queryRunner.query(`
      ALTER TABLE asset
        ADD CONSTRAINT chk_asset_data_quality_flags
        CHECK (data_quality_flags <@ ARRAY[${FLAGS.map((flag) => `'${flag}'`).join(', ')}]::VARCHAR(40)[])
    `);
    await queryRunner.query(`
      CREATE INDEX idx_asset_data_quality_flags ON asset USING GIN (data_quality_flags)
    `);

    await queryRunner.query(`ALTER TABLE asset DROP CONSTRAINT asset_barcode_key`);

    await queryRunner.query(`ALTER TABLE asset ALTER COLUMN acquisition_date DROP NOT NULL`);
    await queryRunner.query(`
      ALTER TABLE asset
        ADD CONSTRAINT chk_asset_acquisition_date_flagged
        CHECK (
          acquisition_date IS NOT NULL
          OR data_quality_flags && ARRAY['ACQUISITION_DATE_MISSING', 'ACQUISITION_DATE_INVALID']::VARCHAR(40)[]
        )
    `);

    await queryRunner.query(`
      ALTER TABLE asset_category ALTER COLUMN requires_photo SET DEFAULT FALSE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [blockers] = (await queryRunner.query(`
      SELECT
        (SELECT count(*) FROM asset WHERE acquisition_date IS NULL)::int AS null_dates,
        (SELECT count(*) FROM (
           SELECT barcode FROM asset WHERE barcode IS NOT NULL
           GROUP BY barcode HAVING count(*) > 1
         ) d)::int AS duplicated_barcodes,
        (SELECT count(*) FROM asset WHERE data_quality_flags <> '{}')::int AS flagged
    `)) as Array<{ null_dates: number; duplicated_barcodes: number; flagged: number }>;
    if (
      blockers &&
      (blockers.null_dates > 0 || blockers.duplicated_barcodes > 0 || blockers.flagged > 0)
    ) {
      throw new Error(
        `No se puede revertir sin perder datos: ${blockers.null_dates} activos sin fecha, ` +
          `${blockers.duplicated_barcodes} códigos de barras repetidos, ${blockers.flagged} activos con banderas de calidad`,
      );
    }

    await queryRunner.query(`
      ALTER TABLE asset_category ALTER COLUMN requires_photo SET DEFAULT TRUE
    `);
    await queryRunner.query(`ALTER TABLE asset DROP CONSTRAINT chk_asset_acquisition_date_flagged`);
    await queryRunner.query(`ALTER TABLE asset ALTER COLUMN acquisition_date SET NOT NULL`);
    await queryRunner.query(`
      ALTER TABLE asset ADD CONSTRAINT asset_barcode_key UNIQUE (barcode)
    `);
    await queryRunner.query(`DROP INDEX idx_asset_data_quality_flags`);
    await queryRunner.query(`ALTER TABLE asset DROP CONSTRAINT chk_asset_data_quality_flags`);
    await queryRunner.query(`ALTER TABLE asset DROP COLUMN data_quality_flags`);
  }
}
