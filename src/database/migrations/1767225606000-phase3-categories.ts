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

    await queryRunner.query(`
      INSERT INTO asset_category (
        code, name, description, parent_id,
        default_useful_life_years, default_depreciation_method,
        requires_serial_number, requires_photo, hierarchy_path, is_active
      )
      SELECT v.code, v.name, v.description, NULL, v.years, 'STRAIGHT_LINE',
             v.requires_serial, TRUE, '/' || lower(v.code), TRUE
      FROM (VALUES
        ('COMPUTADORES', 'Computadores', 'Equipos de cómputo institucionales', 5, TRUE),
        ('MUEBLES', 'Muebles y enseres', 'Mobiliario de oficinas y aulas', 10, FALSE),
        ('EQUIPOS_RED', 'Equipos de red', 'Switches, routers y access points', 5, TRUE),
        ('IMPRESORAS', 'Impresoras y multifuncionales', 'Equipos de impresión', 5, TRUE),
        ('AUDIOVISUAL', 'Equipos audiovisuales', 'Proyectores, pantallas y audio', 5, TRUE),
        ('LABORATORIO', 'Equipos de laboratorio', 'Instrumentación académica', 8, TRUE),
        ('VEHICULOS', 'Vehículos', 'Parque automotor institucional', 10, TRUE),
        ('OTROS', 'Otros activos', 'Activos que no encajan en otro catálogo', 5, FALSE)
      ) AS v(code, name, description, years, requires_serial)
      WHERE NOT EXISTS (
        SELECT 1 FROM asset_category c WHERE c.code = v.code
      )
    `);

    await queryRunner.query(`
      INSERT INTO asset_category (
        code, name, description, parent_id,
        default_useful_life_years, default_depreciation_method,
        requires_serial_number, requires_photo, hierarchy_path, is_active
      )
      SELECT v.code, v.name, v.description, p.id, v.years, 'STRAIGHT_LINE',
             v.requires_serial, TRUE, p.hierarchy_path || '/' || lower(v.code), TRUE
      FROM asset_category p
      JOIN (VALUES
        ('COMPUTADORES', 'PORTATILES', 'Portátiles', 'Computadores portátiles', 4, TRUE),
        ('COMPUTADORES', 'ESCRITORIO', 'Computadores de escritorio', 'Torres y all-in-one', 5, TRUE),
        ('MUEBLES', 'SILLAS', 'Sillas', 'Sillas de oficina y aula', 8, FALSE),
        ('MUEBLES', 'MESAS', 'Mesas y escritorios', 'Mesas de trabajo', 10, FALSE)
      ) AS v(parent_code, code, name, description, years, requires_serial)
        ON v.parent_code = p.code
      WHERE NOT EXISTS (
        SELECT 1 FROM asset_category c WHERE c.code = v.code
      )
    `);

    await queryRunner.query(`
      INSERT INTO asset_category (
        code, name, description, parent_id,
        default_useful_life_years, default_depreciation_method,
        requires_serial_number, requires_photo, hierarchy_path, is_active
      )
      SELECT 'SILLAS_ERGONOMICAS', 'Sillas ergonómicas', 'Sillas con soporte lumbar',
             p.id, 8, 'STRAIGHT_LINE', FALSE, TRUE,
             p.hierarchy_path || '/sillas_ergonomicas', TRUE
      FROM asset_category p
      WHERE p.code = 'SILLAS'
        AND NOT EXISTS (
          SELECT 1 FROM asset_category WHERE code = 'SILLAS_ERGONOMICAS'
        )
    `);

    await queryRunner.query(`
      INSERT INTO asset_category_field (
        category_id, field_code, field_label, field_type, is_required,
        default_value, options, validation_rules, display_order, is_active
      )
      SELECT c.id, v.field_code, v.field_label, v.field_type, v.is_required,
             v.default_value, v.options::jsonb, v.validation_rules::jsonb,
             v.display_order, TRUE
      FROM asset_category c
      JOIN (VALUES
        ('COMPUTADORES', 'procesador', 'Procesador', 'STRING', TRUE, NULL, NULL, NULL, 10),
        ('COMPUTADORES', 'ramGB', 'Memoria RAM (GB)', 'NUMBER', TRUE, NULL, NULL, '{"min":1,"max":256}', 20),
        ('COMPUTADORES', 'hostname', 'Hostname', 'STRING', FALSE, NULL, NULL, NULL, 30),
        ('COMPUTADORES', 'sistemaOperativo', 'Sistema operativo', 'SELECT', TRUE, 'Windows', '["Windows","macOS","Linux"]', NULL, 40),
        ('PORTATILES', 'tamanoPantallaPulgadas', 'Tamaño de pantalla (pulgadas)', 'NUMBER', TRUE, NULL, NULL, '{"min":10,"max":20}', 50)
      ) AS v(
        category_code, field_code, field_label, field_type, is_required,
        default_value, options, validation_rules, display_order
      ) ON v.category_code = c.code
      ON CONFLICT (category_id, field_code) DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM asset_category_field
      WHERE field_code IN (
        'procesador', 'ramGB', 'hostname', 'sistemaOperativo', 'tamanoPantallaPulgadas'
      )
    `);
    await queryRunner.query(
      `DELETE FROM asset_category WHERE code = 'SILLAS_ERGONOMICAS'`,
    );
    await queryRunner.query(`
      DELETE FROM asset_category
      WHERE code IN ('PORTATILES', 'ESCRITORIO', 'SILLAS', 'MESAS')
    `);
    await queryRunner.query(`
      DELETE FROM asset_category
      WHERE code IN (
        'COMPUTADORES', 'MUEBLES', 'EQUIPOS_RED', 'IMPRESORAS',
        'AUDIOVISUAL', 'LABORATORIO', 'VEHICULOS', 'OTROS'
      )
    `);
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
