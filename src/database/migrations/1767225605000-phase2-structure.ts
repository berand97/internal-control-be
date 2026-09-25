import type { MigrationInterface, QueryRunner } from 'typeorm';

export class Phase2Structure1767225605000 implements MigrationInterface {
  name = 'Phase2Structure1767225605000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE campus
        ADD COLUMN IF NOT EXISTS department VARCHAR(100),
        ADD COLUMN IF NOT EXISTS country VARCHAR(100)
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS cost_center_sync_log (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        filename            VARCHAR(255) NOT NULL,
        created_count       INTEGER NOT NULL DEFAULT 0,
        updated_count       INTEGER NOT NULL DEFAULT 0,
        deactivated_count   INTEGER NOT NULL DEFAULT 0,
        reactivated_count   INTEGER NOT NULL DEFAULT 0,
        performed_by        UUID REFERENCES app_user(id),
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION fn_check_org_unit_no_cycle()
      RETURNS TRIGGER AS $$
      DECLARE
        v_current UUID;
      BEGIN
        IF NEW.parent_id IS NULL THEN
          RETURN NEW;
        END IF;
        IF NEW.parent_id = NEW.id THEN
          RAISE EXCEPTION 'Ciclo detectado en organizational_unit para %', NEW.code;
        END IF;
        v_current := NEW.parent_id;
        WHILE v_current IS NOT NULL LOOP
          IF v_current = NEW.id THEN
            RAISE EXCEPTION 'Ciclo detectado en organizational_unit para %', NEW.code;
          END IF;
          SELECT parent_id INTO v_current FROM organizational_unit WHERE id = v_current;
        END LOOP;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_org_unit_no_cycle ON organizational_unit
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_org_unit_no_cycle
        BEFORE INSERT OR UPDATE OF parent_id ON organizational_unit
        FOR EACH ROW EXECUTE FUNCTION fn_check_org_unit_no_cycle()
    `);

    await queryRunner.query(`
      INSERT INTO permission (code, module, resource_type, action, scope_level, description)
      VALUES
        ('campus:read:global',       'STRUCTURE', 'campus',       'read',   'GLOBAL', 'Consultar campus'),
        ('campus:manage:global',     'STRUCTURE', 'campus',       'manage', 'GLOBAL', 'Crear, editar y desactivar campus'),
        ('building:read:global',     'STRUCTURE', 'building',     'read',   'GLOBAL', 'Consultar edificios'),
        ('building:manage:global',   'STRUCTURE', 'building',     'manage', 'GLOBAL', 'Crear, editar y desactivar edificios'),
        ('location:read:global',     'STRUCTURE', 'location',     'read',   'GLOBAL', 'Consultar ubicaciones'),
        ('location:manage:global',   'STRUCTURE', 'location',     'manage', 'GLOBAL', 'Crear, editar y desactivar ubicaciones'),
        ('org_unit:read:global',     'STRUCTURE', 'org_unit',     'read',   'GLOBAL', 'Consultar unidades organizacionales'),
        ('org_unit:manage:global',   'STRUCTURE', 'org_unit',     'manage', 'GLOBAL', 'Crear, editar y desactivar unidades organizacionales'),
        ('cost_center:read:global',  'STRUCTURE', 'cost_center',  'read',   'GLOBAL', 'Consultar centros de costo'),
        ('cost_center:manage:global','STRUCTURE', 'cost_center',  'manage', 'GLOBAL', 'Crear, editar, desactivar y sincronizar centros de costo')
      ON CONFLICT (code) DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO role_permission (role_id, permission_id)
      SELECT r.id, p.id
      FROM role r
      JOIN permission p ON p.code IN (
        'campus:read:global',
        'building:read:global',
        'location:read:global',
        'org_unit:read:global',
        'cost_center:read:global'
      )
      ON CONFLICT DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO role_permission (role_id, permission_id)
      SELECT r.id, p.id
      FROM role r
      JOIN permission p ON p.code IN (
        'campus:manage:global',
        'building:manage:global',
        'location:manage:global',
        'org_unit:manage:global',
        'cost_center:manage:global'
      )
      WHERE r.code IN ('SUPER_ADMIN', 'INTERNAL_CONTROL_DIRECTOR')
      ON CONFLICT DO NOTHING
    `);

  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM role_permission
      WHERE permission_id IN (
        SELECT id FROM permission
        WHERE code IN (
          'campus:read:global', 'campus:manage:global',
          'building:read:global', 'building:manage:global',
          'location:read:global', 'location:manage:global',
          'org_unit:read:global', 'org_unit:manage:global',
          'cost_center:read:global', 'cost_center:manage:global'
        )
      )
    `);
    await queryRunner.query(`
      DELETE FROM permission
      WHERE code IN (
        'campus:read:global', 'campus:manage:global',
        'building:read:global', 'building:manage:global',
        'location:read:global', 'location:manage:global',
        'org_unit:read:global', 'org_unit:manage:global',
        'cost_center:read:global', 'cost_center:manage:global'
      )
    `);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_org_unit_no_cycle ON organizational_unit`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS fn_check_org_unit_no_cycle()`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS cost_center_sync_log`);
    await queryRunner.query(`
      ALTER TABLE campus
        DROP COLUMN IF EXISTS department,
        DROP COLUMN IF EXISTS country
    `);
  }
}
