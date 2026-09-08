import type { MigrationInterface, QueryRunner } from 'typeorm';

export class FeatureFlags1767225610000 implements MigrationInterface {
  name = 'FeatureFlags1767225610000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS feature_flag (
        code             VARCHAR(50) PRIMARY KEY,
        enabled          BOOLEAN NOT NULL DEFAULT TRUE,
        disabled_reason  VARCHAR(20),
        disabled_at      TIMESTAMPTZ,
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT feature_flag_reason_chk CHECK (
          disabled_reason IS NULL
          OR disabled_reason IN ('MANUAL', 'CIRCUIT', 'ENV')
        )
      )
    `);

    await queryRunner.query(`
      INSERT INTO permission (code, module, resource_type, action, scope_level, description)
      VALUES (
        'feature:manage:global',
        'SYSTEM',
        'feature',
        'manage',
        'GLOBAL',
        'Activar o desactivar módulos del sistema'
      )
      ON CONFLICT (code) DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO role_permission (role_id, permission_id)
      SELECT r.id, p.id
      FROM role r
      JOIN permission p ON p.code = 'feature:manage:global'
      WHERE r.code = 'SUPER_ADMIN'
      ON CONFLICT DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM role_permission
      WHERE permission_id IN (
        SELECT id FROM permission WHERE code = 'feature:manage:global'
      )
    `);
    await queryRunner.query(`
      DELETE FROM permission WHERE code = 'feature:manage:global'
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS feature_flag`);
  }
}
