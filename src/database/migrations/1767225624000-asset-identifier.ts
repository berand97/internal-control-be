import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AssetIdentifier1767225624000 implements MigrationInterface {
  name = 'AssetIdentifier1767225624000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE asset_identifier (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        asset_id         UUID NOT NULL REFERENCES asset(id),
        identifier_type  VARCHAR(20) NOT NULL,
        value            VARCHAR(100) NOT NULL,
        origin           VARCHAR(20) NOT NULL,
        valid_from       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        valid_to         TIMESTAMPTZ,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by       UUID REFERENCES app_user(id),
        CONSTRAINT chk_asset_identifier_type
          CHECK (identifier_type IN ('LEGACY_CODE', 'VISIBLE_CODE', 'OPAQUE_ID')),
        CONSTRAINT chk_asset_identifier_origin
          CHECK (origin IN ('IMPORTED', 'GENERATED', 'MANUAL')),
        CONSTRAINT chk_asset_identifier_validity
          CHECK (valid_to IS NULL OR valid_to > valid_from)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_asset_identifier_visible_current
        ON asset_identifier (value)
        WHERE identifier_type = 'VISIBLE_CODE' AND valid_to IS NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_asset_identifier_opaque
        ON asset_identifier (value)
        WHERE identifier_type = 'OPAQUE_ID'
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_asset_identifier_one_current_per_asset
        ON asset_identifier (asset_id, identifier_type)
        WHERE identifier_type IN ('VISIBLE_CODE', 'OPAQUE_ID') AND valid_to IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX idx_asset_identifier_asset ON asset_identifier (asset_id)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_asset_identifier_lookup
        ON asset_identifier (identifier_type, value)
    `);

    await queryRunner.query(`
      INSERT INTO asset_identifier (asset_id, identifier_type, value, origin, valid_from)
      SELECT id, 'VISIBLE_CODE', internal_code,
             CASE WHEN internal_code ~ '^A[0-9]{4}-[0-9]+$' THEN 'GENERATED' ELSE 'IMPORTED' END,
             created_at
      FROM asset
    `);
    await queryRunner.query(`
      INSERT INTO asset_identifier (asset_id, identifier_type, value, origin, valid_from)
      SELECT id, 'LEGACY_CODE', barcode, 'IMPORTED', created_at
      FROM asset
      WHERE barcode IS NOT NULL
    `);
    await queryRunner.query(`
      INSERT INTO asset_identifier (asset_id, identifier_type, value, origin, valid_from)
      SELECT id, 'OPAQUE_ID', gen_random_uuid()::text, 'GENERATED', created_at
      FROM asset
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows = (await queryRunner.query(`
      SELECT count(*)::int AS count
      FROM asset_identifier i
      JOIN asset a ON a.id = i.asset_id
      WHERE i.valid_to IS NOT NULL
         OR (i.identifier_type = 'VISIBLE_CODE' AND i.value <> a.internal_code)
         OR (i.identifier_type = 'LEGACY_CODE' AND i.value IS DISTINCT FROM a.barcode)
    `)) as Array<{ count: number }>;
    if ((rows[0]?.count ?? 0) > 0) {
      throw new Error(
        'asset_identifier tiene identificadores que no están en asset.internal_code/barcode; revertir los perdería',
      );
    }
    await queryRunner.query(`DROP TABLE asset_identifier`);
  }
}
