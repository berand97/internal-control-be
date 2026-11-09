import { MigrationInterface, QueryRunner } from 'typeorm';

export class InventoryFieldCloseSignature1767226150000 implements MigrationInterface {
  name = 'InventoryFieldCloseSignature1767226150000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE physical_inventory
        ADD COLUMN IF NOT EXISTS field_close_signature_png text,
        ADD COLUMN IF NOT EXISTS field_close_signature_sha256 varchar(64),
        ADD COLUMN IF NOT EXISTS field_close_signed_at timestamptz,
        ADD COLUMN IF NOT EXISTS field_close_captured_by uuid
          REFERENCES app_user(id)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE physical_inventory
        DROP COLUMN IF EXISTS field_close_captured_by,
        DROP COLUMN IF EXISTS field_close_signed_at,
        DROP COLUMN IF EXISTS field_close_signature_sha256,
        DROP COLUMN IF EXISTS field_close_signature_png
    `);
  }
}
