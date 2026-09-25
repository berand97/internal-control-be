import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AssetSearchIndexes1767225629000 implements MigrationInterface {
  name = 'AssetSearchIndexes1767225629000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE INDEX idx_asset_internal_code_trgm ON asset USING gin (internal_code gin_trgm_ops)',
    );
    await queryRunner.query(
      'CREATE INDEX idx_asset_serial_trgm ON asset USING gin (serial_number gin_trgm_ops) WHERE serial_number IS NOT NULL',
    );
    await queryRunner.query(`
      CREATE INDEX idx_asset_identifier_value_trgm ON asset_identifier USING gin (value gin_trgm_ops)
        WHERE identifier_type <> 'OPAQUE_ID'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX idx_asset_identifier_value_trgm');
    await queryRunner.query('DROP INDEX idx_asset_serial_trgm');
    await queryRunner.query('DROP INDEX idx_asset_internal_code_trgm');
  }
}
