import type { MigrationInterface, QueryRunner } from 'typeorm';

export class Phase4Assets1767225607000 implements MigrationInterface {
  name = 'Phase4Assets1767225607000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS asset_import_batch (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        filename      VARCHAR(255) NOT NULL,
        payload       JSONB NOT NULL,
        expires_at    TIMESTAMPTZ NOT NULL,
        created_by    UUID NOT NULL REFERENCES app_user(id),
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        committed_at  TIMESTAMPTZ
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS qr_token_rotation_log (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        asset_id        UUID NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
        token_version   SMALLINT NOT NULL,
        jti             VARCHAR(64) NOT NULL,
        action          VARCHAR(20) NOT NULL,
        performed_by    UUID REFERENCES app_user(id),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_qr_rotation_asset
        ON qr_token_rotation_log(asset_id, created_at DESC)
    `);

    await queryRunner.query(`
      INSERT INTO role_permission (role_id, permission_id)
      SELECT r.id, p.id
      FROM role r
      JOIN permission p ON p.code IN (
        'asset:read:global'
      )
      ON CONFLICT DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO role_permission (role_id, permission_id)
      SELECT r.id, p.id
      FROM role r
      JOIN permission p ON p.code IN (
        'asset:create:global',
        'asset:update:global',
        'asset:write_off:global',
        'asset:sign_qr:global',
        'asset:export:global'
      )
      WHERE r.code IN ('SUPER_ADMIN', 'INTERNAL_CONTROL_DIRECTOR')
      ON CONFLICT DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM role_permission
      WHERE permission_id IN (
        SELECT id FROM permission WHERE code IN (
          'asset:read:global',
          'asset:create:global',
          'asset:update:global',
          'asset:write_off:global',
          'asset:sign_qr:global',
          'asset:export:global'
        )
      )
      AND role_id IN (SELECT id FROM role WHERE code = 'SUPER_ADMIN')
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS qr_token_rotation_log`);
    await queryRunner.query(`DROP TABLE IF EXISTS asset_import_batch`);
  }
}
