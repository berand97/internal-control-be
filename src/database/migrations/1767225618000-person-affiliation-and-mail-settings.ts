import type { MigrationInterface, QueryRunner } from 'typeorm';

export class PersonAffiliationAndMailSettings1767225618000 implements MigrationInterface {
  name = 'PersonAffiliationAndMailSettings1767225618000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE person
        ADD COLUMN IF NOT EXISTS organizational_unit_id UUID,
        ADD COLUMN IF NOT EXISTS cost_center_id UUID
    `);
    await queryRunner.query(`
      ALTER TABLE person
        DROP CONSTRAINT IF EXISTS person_organizational_unit_id_fkey
    `);
    await queryRunner.query(`
      ALTER TABLE person
        ADD CONSTRAINT person_organizational_unit_id_fkey
        FOREIGN KEY (organizational_unit_id)
        REFERENCES organizational_unit (id)
        ON DELETE SET NULL
    `);
    await queryRunner.query(`
      ALTER TABLE person
        DROP CONSTRAINT IF EXISTS person_cost_center_id_fkey
    `);
    await queryRunner.query(`
      ALTER TABLE person
        ADD CONSTRAINT person_cost_center_id_fkey
        FOREIGN KEY (cost_center_id)
        REFERENCES cost_center (id)
        ON DELETE SET NULL
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS mail_settings (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        host        VARCHAR(255),
        port        INTEGER NOT NULL DEFAULT 587,
        secure      BOOLEAN NOT NULL DEFAULT FALSE,
        username    TEXT,
        password    TEXT,
        from_name   VARCHAR(150),
        from_email  VARCHAR(255),
        enabled     BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by  UUID
      )
    `);
    await queryRunner.query(`
      INSERT INTO mail_settings (enabled)
      SELECT FALSE
      WHERE NOT EXISTS (SELECT 1 FROM mail_settings)
    `);

    await queryRunner.query(`
      INSERT INTO permission
        (code, module, resource_type, resource_label, action, scope_level, description, is_system)
      VALUES (
        'mail:manage:global',
        'SYSTEM',
        'mail',
        'Correo',
        'manage',
        'GLOBAL',
        'Administrar SMTP y envío de correos',
        TRUE
      )
      ON CONFLICT (code) DO NOTHING
    `);
    await queryRunner.query(`
      INSERT INTO role_permission (role_id, permission_id)
      SELECT r.id, p.id
      FROM role r
      JOIN permission p ON p.code = 'mail:manage:global'
      WHERE r.code = 'SUPER_ADMIN'
      ON CONFLICT DO NOTHING
    `);
    await queryRunner.query(`
      INSERT INTO navigation_item
        (module, module_label, resource, path, label, required_action, sort_order)
      VALUES
        ('SYSTEM', 'Sistema', 'mail', '/mail', 'Correo', 'manage', 105)
      ON CONFLICT (path) DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM role_permission
      WHERE permission_id IN (
        SELECT id FROM permission WHERE code = 'mail:manage:global'
      )
    `);
    await queryRunner.query(`
      DELETE FROM permission WHERE code = 'mail:manage:global'
    `);
    await queryRunner.query(`
      DELETE FROM navigation_item WHERE path = '/mail'
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS mail_settings`);
    await queryRunner.query(`
      ALTER TABLE person
        DROP CONSTRAINT IF EXISTS person_cost_center_id_fkey,
        DROP CONSTRAINT IF EXISTS person_organizational_unit_id_fkey,
        DROP COLUMN IF EXISTS cost_center_id,
        DROP COLUMN IF EXISTS organizational_unit_id
    `);
  }
}
