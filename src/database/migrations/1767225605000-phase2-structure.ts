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

    await queryRunner.query(`
      INSERT INTO campus (code, name, address, city, department, country)
      VALUES (
        'MED',
        'Campus Medellín',
        'Carrera 84 No. 33AA-1',
        'Medellín',
        'Antioquia',
        'Colombia'
      )
      ON CONFLICT (code) DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO building (campus_id, code, name, floors_count)
      SELECT c.id, v.code, v.name, v.floors_count
      FROM campus c
      CROSS JOIN (VALUES
        ('A', 'Bloque A', 4),
        ('B', 'Bloque B', 3),
        ('C', 'Bloque Administrativo', 2)
      ) AS v(code, name, floors_count)
      WHERE c.code = 'MED'
      ON CONFLICT (campus_id, code) DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO location (building_id, code, name, floor_number, location_type)
      SELECT b.id, v.code, v.name, v.floor_number, v.location_type
      FROM building b
      JOIN campus c ON c.id = b.campus_id AND c.code = 'MED'
      JOIN (VALUES
        ('A', 'A-101', 'Oficina Rectoría', 1, 'OFFICE'),
        ('A', 'A-102', 'Oficina Secretaría', 1, 'OFFICE'),
        ('A', 'A-201', 'Aula 201', 2, 'CLASSROOM'),
        ('A', 'A-202', 'Aula 202', 2, 'CLASSROOM'),
        ('A', 'A-203', 'Aula 203', 2, 'CLASSROOM'),
        ('A', 'A-301', 'Laboratorio de Sistemas', 3, 'LAB'),
        ('A', 'A-302', 'Laboratorio de Redes', 3, 'LAB'),
        ('A', 'A-401', 'Sala de profesores', 4, 'OFFICE'),
        ('B', 'B-101', 'Aula 101', 1, 'CLASSROOM'),
        ('B', 'B-102', 'Aula 102', 1, 'CLASSROOM'),
        ('B', 'B-201', 'Laboratorio de Química', 2, 'LAB'),
        ('B', 'B-202', 'Laboratorio de Física', 2, 'LAB'),
        ('B', 'B-301', 'Bodega de materiales', 3, 'WAREHOUSE'),
        ('B', 'B-HALL', 'Hall principal', 1, 'COMMON_AREA'),
        ('C', 'C-101', 'Oficina Control Interno', 1, 'OFFICE'),
        ('C', 'C-102', 'Oficina Talento Humano', 1, 'OFFICE'),
        ('C', 'C-103', 'Sala de juntas', 1, 'OFFICE'),
        ('C', 'C-201', 'Archivo', 2, 'WAREHOUSE'),
        ('C', 'C-202', 'Bodega de activos', 2, 'WAREHOUSE'),
        ('C', 'C-CAFE', 'Cafetería', 1, 'COMMON_AREA')
      ) AS v(building_code, code, name, floor_number, location_type)
        ON v.building_code = b.code
      ON CONFLICT (building_id, code) DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO organizational_unit (code, name, unit_type, parent_id, hierarchy_level, hierarchy_path)
      SELECT 'REC', 'Rectoría', 'RECTORATE', NULL, 0, '/rec'
      WHERE NOT EXISTS (SELECT 1 FROM organizational_unit WHERE code = 'REC')
    `);

    await queryRunner.query(`
      INSERT INTO organizational_unit (code, name, unit_type, parent_id, hierarchy_level, hierarchy_path)
      SELECT v.code, v.name, v.unit_type, p.id, 1, '/rec/' || lower(v.code)
      FROM organizational_unit p
      CROSS JOIN (VALUES
        ('VAC', 'Vicerrectoría Académica', 'VICERECTORATE'),
        ('VAD', 'Vicerrectoría Administrativa', 'VICERECTORATE'),
        ('VDE', 'Vicerrectoría de Desarrollo Estudiantil', 'VICERECTORATE'),
        ('VIN', 'Vicerrectoría de Investigación', 'VICERECTORATE')
      ) AS v(code, name, unit_type)
      WHERE p.code = 'REC'
        AND NOT EXISTS (SELECT 1 FROM organizational_unit u WHERE u.code = v.code)
    `);

    await queryRunner.query(`
      INSERT INTO organizational_unit (code, name, unit_type, parent_id, hierarchy_level, hierarchy_path)
      SELECT v.code, v.name, v.unit_type, p.id, 2, p.hierarchy_path || '/' || lower(v.code)
      FROM organizational_unit p
      JOIN (VALUES
        ('VAC', 'FING', 'Facultad de Ingeniería', 'FACULTY'),
        ('VAC', 'FCED', 'Facultad de Ciencias de la Educación', 'FACULTY'),
        ('VAD', 'DTH', 'Departamento de Talento Humano', 'DEPARTMENT'),
        ('VAD', 'DCI', 'Departamento de Control Interno', 'DEPARTMENT'),
        ('VAD', 'DFIN', 'Departamento Financiero', 'DEPARTMENT')
      ) AS v(parent_code, code, name, unit_type) ON v.parent_code = p.code
      WHERE NOT EXISTS (SELECT 1 FROM organizational_unit u WHERE u.code = v.code)
    `);

    await queryRunner.query(`
      INSERT INTO organizational_unit (code, name, unit_type, parent_id, hierarchy_level, hierarchy_path)
      SELECT 'DSIS', 'Departamento de Sistemas', 'DEPARTMENT', p.id, 3, p.hierarchy_path || '/dsis'
      FROM organizational_unit p
      WHERE p.code = 'FING'
        AND NOT EXISTS (SELECT 1 FROM organizational_unit WHERE code = 'DSIS')
    `);

    await queryRunner.query(`
      INSERT INTO cost_center (external_code, name, organizational_unit_id, accepts_assets, sync_source)
      SELECT v.external_code, v.name, u.id, TRUE, 'MANUAL'
      FROM (VALUES
        ('1100', 'Rectoría', 'REC'),
        ('4100', 'Control Interno', 'DCI'),
        ('4330', 'Talento Humano', 'DTH'),
        ('4200', 'Financiera', 'DFIN')
      ) AS v(external_code, name, unit_code)
      JOIN organizational_unit u ON u.code = v.unit_code
      ON CONFLICT (external_code) DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM cost_center
      WHERE external_code IN ('1100', '4100', '4330', '4200')
    `);
    await queryRunner.query(`
      DELETE FROM organizational_unit
      WHERE code IN ('DSIS', 'FING', 'FCED', 'DTH', 'DCI', 'DFIN', 'VAC', 'VAD', 'VDE', 'VIN', 'REC')
    `);
    await queryRunner.query(`
      DELETE FROM location
      WHERE code IN (
        'A-101','A-102','A-201','A-202','A-203','A-301','A-302','A-401',
        'B-101','B-102','B-201','B-202','B-301','B-HALL',
        'C-101','C-102','C-103','C-201','C-202','C-CAFE'
      )
    `);
    await queryRunner.query(`
      DELETE FROM building
      WHERE code IN ('A', 'B', 'C')
        AND campus_id IN (SELECT id FROM campus WHERE code = 'MED')
    `);
    await queryRunner.query(`DELETE FROM campus WHERE code = 'MED'`);
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
