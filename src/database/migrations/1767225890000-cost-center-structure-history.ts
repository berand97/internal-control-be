import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Estructura de los centros de costo con historial.
 *
 * - cost_center.has_movement: el centro recibe movimientos contables (1) o es un nodo agrupador (0), como la columna
 *   «Movimiento» del plan de centros de Contabilidad. Distinta de accepts_assets, que no se toca aquí.
 * - organizational_unit.code_prefix: dígito(s) inicial(es) del rango de códigos de los centros de la unidad (4 →
 *   4000–4999). Único entre unidades activas. No se siembran unidades: se crean desde la importación o el CRUD.
 * - cost_center_placement: dónde estuvo cada centro (unidad, centro padre, movimiento) y desde/hasta cuándo, con
 *   motivo, quién, IP, agente y origen (MANUAL, IMPORT, MIGRATION). Sin solapes por centro: EXCLUDE con tstzrange
 *   (btree_gist para la igualdad del uuid), así ni un INSERT a mano deja dos ubicaciones vigentes a la vez; el
 *   servicio además bloquea el centro (FOR UPDATE) para que dos cambios simultáneos no choquen contra el EXCLUDE.
 *   cost_center.parent_id / organizational_unit_id / has_movement quedan como caché de la fila vigente.
 * - Cada centro existente recibe su fila vigente con el estado actual (source MIGRATION, desde su created_at: es lo
 *   único que se sabe de su historia).
 * - trg_cost_center_initial_placement (diferido al commit): un centro creado por un camino que no abre su historial
 *   (sincronización CSV, un INSERT a mano) recibe su fila inicial; si el servicio ya la abrió en la misma
 *   transacción, no hace nada.
 *
 * down(): se niega si hay historial que se perdería (filas que no son la inicial de la migración o del alta, centros
 * agrupadores, unidades con prefijo). No borra btree_gist (puede usarlo otra cosa).
 */
export class CostCenterStructureHistory1767225890000 implements MigrationInterface {
  name = 'CostCenterStructureHistory1767225890000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS btree_gist');

    await queryRunner.query('ALTER TABLE cost_center ADD COLUMN has_movement BOOLEAN NOT NULL DEFAULT TRUE');

    await queryRunner.query('ALTER TABLE organizational_unit ADD COLUMN code_prefix VARCHAR(4)');
    await queryRunner.query(
      `ALTER TABLE organizational_unit ADD CONSTRAINT chk_org_unit_code_prefix CHECK (code_prefix ~ '^[0-9]{1,4}$')`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX uq_org_unit_code_prefix_active ON organizational_unit (code_prefix)
       WHERE is_active AND code_prefix IS NOT NULL`,
    );

    await queryRunner.query(`
      CREATE TABLE cost_center_placement (
        id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        cost_center_id          UUID NOT NULL REFERENCES cost_center(id),
        organizational_unit_id  UUID REFERENCES organizational_unit(id),
        parent_cost_center_id   UUID REFERENCES cost_center(id),
        has_movement            BOOLEAN NOT NULL,
        valid_from              TIMESTAMPTZ NOT NULL,
        valid_until             TIMESTAMPTZ,
        reason                  TEXT NOT NULL,
        changed_by              UUID REFERENCES app_user(id),
        changed_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ip_address              INET,
        user_agent              TEXT,
        source                  VARCHAR(20) NOT NULL,
        staging_import_id       UUID REFERENCES staging_import(id),
        CONSTRAINT chk_cc_placement_source CHECK (source IN ('MANUAL', 'IMPORT', 'MIGRATION')),
        CONSTRAINT chk_cc_placement_import CHECK (staging_import_id IS NULL OR source = 'IMPORT'),
        CONSTRAINT chk_cc_placement_reason CHECK (length(btrim(reason)) >= 3),
        CONSTRAINT chk_cc_placement_range CHECK (valid_until IS NULL OR valid_until >= valid_from),
        CONSTRAINT chk_cc_placement_not_self CHECK (parent_cost_center_id IS DISTINCT FROM cost_center_id),
        CONSTRAINT ex_cc_placement_overlap EXCLUDE USING gist (
          cost_center_id WITH =,
          tstzrange(valid_from, valid_until, '[)') WITH &&
        )
      )
    `);
    await queryRunner.query(
      'CREATE UNIQUE INDEX uq_cc_placement_current ON cost_center_placement (cost_center_id) WHERE valid_until IS NULL',
    );
    await queryRunner.query('CREATE INDEX idx_cc_placement_unit ON cost_center_placement (organizational_unit_id)');
    await queryRunner.query('CREATE INDEX idx_cc_placement_parent ON cost_center_placement (parent_cost_center_id)');

    await queryRunner.query(`
      INSERT INTO cost_center_placement (cost_center_id, organizational_unit_id, parent_cost_center_id, has_movement,
        valid_from, reason, source)
      SELECT id, organizational_unit_id, parent_id, has_movement, created_at,
             'Estado inicial al activar el historial', 'MIGRATION'
      FROM cost_center
    `);

    await queryRunner.query(`
      CREATE FUNCTION fn_cost_center_initial_placement() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM cost_center_placement WHERE cost_center_id = NEW.id) THEN
          INSERT INTO cost_center_placement (cost_center_id, organizational_unit_id, parent_cost_center_id,
            has_movement, valid_from, reason, source)
          SELECT id, organizational_unit_id, parent_id, has_movement, created_at,
                 'Alta del centro de costo sin historial abierto por la aplicación',
                 CASE WHEN sync_source = 'MANUAL' THEN 'MANUAL' ELSE 'IMPORT' END
          FROM cost_center WHERE id = NEW.id;
        END IF;
        RETURN NULL;
      END $$
    `);
    await queryRunner.query(`
      CREATE CONSTRAINT TRIGGER trg_cost_center_initial_placement
      AFTER INSERT ON cost_center DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION fn_cost_center_initial_placement()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [row] = (await queryRunner.query(`
      SELECT
        (SELECT count(*) FROM cost_center_placement p
          WHERE p.valid_until IS NOT NULL
             OR p.cost_center_id IN (SELECT cost_center_id FROM cost_center_placement GROUP BY cost_center_id HAVING count(*) > 1))::int AS history,
        (SELECT count(*) FROM cost_center WHERE NOT has_movement)::int AS grouping,
        (SELECT count(*) FROM organizational_unit WHERE code_prefix IS NOT NULL)::int AS prefixes
    `)) as Array<{ history: number; grouping: number; prefixes: number }>;
    if (row && (row.history > 0 || row.grouping > 0 || row.prefixes > 0)) {
      throw new Error(
        `No se puede revertir sin perder datos: ${row.history} ubicaciones históricas de centros de costo, ` +
          `${row.grouping} centros agrupadores, ${row.prefixes} unidades con prefijo de código`,
      );
    }
    await queryRunner.query('DROP TRIGGER trg_cost_center_initial_placement ON cost_center');
    await queryRunner.query('DROP FUNCTION fn_cost_center_initial_placement()');
    await queryRunner.query('DROP TABLE cost_center_placement');
    await queryRunner.query('DROP INDEX uq_org_unit_code_prefix_active');
    await queryRunner.query('ALTER TABLE organizational_unit DROP CONSTRAINT chk_org_unit_code_prefix');
    await queryRunner.query('ALTER TABLE organizational_unit DROP COLUMN code_prefix');
    await queryRunner.query('ALTER TABLE cost_center DROP COLUMN has_movement');
  }
}
