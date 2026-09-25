import type { MigrationInterface, QueryRunner } from 'typeorm';

export class Phase3Categories1767225606000 implements MigrationInterface {
  name = 'Phase3Categories1767225606000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE asset_category_field
        ADD COLUMN IF NOT EXISTS default_value TEXT
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION fn_check_asset_category_no_cycle()
      RETURNS TRIGGER AS $$
      DECLARE
        v_current UUID;
      BEGIN
        IF NEW.parent_id IS NULL THEN
          RETURN NEW;
        END IF;
        IF NEW.parent_id = NEW.id THEN
          RAISE EXCEPTION 'Ciclo detectado en asset_category para %', NEW.code;
        END IF;
        v_current := NEW.parent_id;
        WHILE v_current IS NOT NULL LOOP
          IF v_current = NEW.id THEN
            RAISE EXCEPTION 'Ciclo detectado en asset_category para %', NEW.code;
          END IF;
          SELECT parent_id INTO v_current FROM asset_category WHERE id = v_current;
        END LOOP;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_asset_category_no_cycle ON asset_category
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_asset_category_no_cycle
        BEFORE INSERT OR UPDATE OF parent_id ON asset_category
        FOR EACH ROW EXECUTE FUNCTION fn_check_asset_category_no_cycle()
    `);

    await queryRunner.query(`
      INSERT INTO permission (code, module, resource_type, action, scope_level, description)
      VALUES
        ('category:read:global',   'ASSET', 'category', 'read',   'GLOBAL', 'Consultar categorías y campos dinámicos'),
        ('category:manage:global', 'ASSET', 'category', 'manage', 'GLOBAL', 'Crear, editar y desactivar categorías y campos dinámicos')
      ON CONFLICT (code) DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO role_permission (role_id, permission_id)
      SELECT r.id, p.id
      FROM role r
      JOIN permission p ON p.code = 'category:read:global'
      ON CONFLICT DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO role_permission (role_id, permission_id)
      SELECT r.id, p.id
      FROM role r
      JOIN permission p ON p.code = 'category:manage:global'
      WHERE r.code IN ('SUPER_ADMIN', 'INTERNAL_CONTROL_DIRECTOR')
      ON CONFLICT DO NOTHING
    `);

  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM role_permission
      WHERE permission_id IN (
        SELECT id FROM permission
        WHERE code IN ('category:read:global', 'category:manage:global')
      )
    `);
    await queryRunner.query(`
      DELETE FROM permission
      WHERE code IN ('category:read:global', 'category:manage:global')
    `);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_asset_category_no_cycle ON asset_category`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS fn_check_asset_category_no_cycle()`,
    );
    await queryRunner.query(`
      ALTER TABLE asset_category_field
        DROP COLUMN IF EXISTS default_value
    `);
  }
}
