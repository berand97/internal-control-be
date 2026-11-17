import type { MigrationInterface, QueryRunner } from 'typeorm';

export class InventoryMetricsPhotosCloseReason1767226160000 implements MigrationInterface {
  name = 'InventoryMetricsPhotosCloseReason1767226160000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS inventory_item_photo (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        item_id       UUID NOT NULL REFERENCES physical_inventory_item(id) ON DELETE CASCADE,
        storage_key   TEXT NOT NULL,
        content_type  VARCHAR(64) NOT NULL,
        byte_size     INTEGER NOT NULL,
        taken_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by    UUID NOT NULL REFERENCES app_user(id),
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_inventory_item_photo_item ON inventory_item_photo (item_id, taken_at)',
    );
    await queryRunner.query(`
      ALTER TABLE physical_inventory
        ADD COLUMN IF NOT EXISTS unverified_close_reason TEXT,
        ADD COLUMN IF NOT EXISTS unverified_close_coverage NUMERIC(5,1)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE physical_inventory DROP COLUMN IF EXISTS unverified_close_coverage');
    await queryRunner.query('ALTER TABLE physical_inventory DROP COLUMN IF EXISTS unverified_close_reason');
    await queryRunner.query('DROP TABLE IF EXISTS inventory_item_photo');
  }
}
