import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Organigrama institucional: tipos de cuadro, línea hacia el padre, centro propio, historial de nombres/códigos y
 * previsualizaciones de la importación por Excel.
 *
 * - organizational_unit.unit_type sigue siendo VARCHAR(30) sin CHECK: los tipos nuevos (DIRECTION, OFFICE, CENTER,
 *   COUNCIL, OTHER) solo existen en el enum de la aplicación.
 * - organizational_unit.relation_type: la línea del organigrama hacia su padre (AUTHORITY | ADVISORY | COORDINATION),
 *   por defecto AUTHORITY (todas las existentes).
 * - organizational_unit.head_cost_center_id: centro «propio» del cuadro (la unidad 25 → 2510 Decanatura). Solo se fija
 *   por Excel o PATCH; nunca se deduce. ON DELETE SET NULL: borrar el centro no borra la unidad.
 * - org_structure_history: eventos de cambio de NOMBRE/CÓDIGO de centros y NOMBRE/TIPO/PADRE/PREFIJO/LÍNEA/CENTRO
 *   PROPIO/ESTADO de unidades (la ubicación de los centros sigue en cost_center_placement). Sin FK a la entidad: el
 *   borrado físico borra sus eventos explícitamente; el audit_log conserva el código y el nombre.
 * - org_chart_import: previsualización de un Excel del organigrama (filas leídas y resumen), para confirmarla después
 *   por su id. Solo nombres y códigos de la estructura; ningún dato personal.
 *
 * down(): se niega si hay historial, previsualizaciones, unidades con línea distinta de AUTHORITY, centro propio o
 * tipos nuevos (se perderían).
 */
export class OrgChartStructure1767226020000 implements MigrationInterface {
  name = 'OrgChartStructure1767226020000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE organizational_unit ADD COLUMN relation_type VARCHAR(20) NOT NULL DEFAULT 'AUTHORITY'`,
    );
    await queryRunner.query(
      `ALTER TABLE organizational_unit ADD CONSTRAINT chk_org_unit_relation_type
       CHECK (relation_type IN ('AUTHORITY', 'ADVISORY', 'COORDINATION'))`,
    );
    await queryRunner.query(
      `ALTER TABLE organizational_unit ADD COLUMN head_cost_center_id UUID
       REFERENCES cost_center(id) ON DELETE SET NULL`,
    );
    await queryRunner.query(
      'CREATE INDEX idx_org_unit_head_cost_center ON organizational_unit (head_cost_center_id) WHERE head_cost_center_id IS NOT NULL',
    );

    await queryRunner.query(`
      CREATE TABLE org_structure_history (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        entity_type  VARCHAR(20) NOT NULL,
        entity_id    UUID NOT NULL,
        field        VARCHAR(30) NOT NULL,
        old_value    TEXT,
        new_value    TEXT,
        changed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        changed_by   UUID REFERENCES app_user(id),
        source       VARCHAR(20) NOT NULL,
        reason       TEXT,
        CONSTRAINT chk_org_history_entity CHECK (entity_type IN ('ORG_UNIT', 'COST_CENTER')),
        CONSTRAINT chk_org_history_field CHECK (field IN
          ('NAME', 'CODE', 'TYPE', 'PARENT', 'PREFIX', 'RELATION', 'HEAD_COST_CENTER', 'STATUS')),
        CONSTRAINT chk_org_history_source CHECK (source IN ('MANUAL', 'IMPORT'))
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_org_history_entity ON org_structure_history (entity_type, entity_id, changed_at DESC)',
    );

    await queryRunner.query(`
      CREATE TABLE org_chart_import (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        file_name     VARCHAR(255) NOT NULL,
        file_sha256   CHAR(64) NOT NULL,
        input_rows    JSONB NOT NULL,
        plan_hash     CHAR(64) NOT NULL,
        summary       JSONB NOT NULL,
        has_errors    BOOLEAN NOT NULL,
        status        VARCHAR(20) NOT NULL DEFAULT 'PREVIEWED',
        created_by    UUID NOT NULL REFERENCES app_user(id),
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at    TIMESTAMPTZ NOT NULL,
        confirmed_at  TIMESTAMPTZ,
        CONSTRAINT chk_org_chart_import_status CHECK (status IN ('PREVIEWED', 'CONFIRMED'))
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [row] = (await queryRunner.query(`
      SELECT
        (SELECT count(*) FROM org_structure_history)::int AS history,
        (SELECT count(*) FROM org_chart_import)::int AS imports,
        (SELECT count(*) FROM organizational_unit
          WHERE relation_type <> 'AUTHORITY' OR head_cost_center_id IS NOT NULL
             OR unit_type IN ('DIRECTION', 'OFFICE', 'CENTER', 'COUNCIL', 'OTHER'))::int AS units
    `)) as Array<{ history: number; imports: number; units: number }>;
    if (row && (row.history > 0 || row.imports > 0 || row.units > 0)) {
      throw new Error(
        `No se puede revertir sin perder datos: ${row.history} eventos de historial del organigrama, ` +
          `${row.imports} importaciones del organigrama, ${row.units} unidades con línea, centro propio o tipo nuevo`,
      );
    }
    await queryRunner.query('DROP TABLE org_chart_import');
    await queryRunner.query('DROP TABLE org_structure_history');
    await queryRunner.query('DROP INDEX idx_org_unit_head_cost_center');
    await queryRunner.query('ALTER TABLE organizational_unit DROP COLUMN head_cost_center_id');
    await queryRunner.query('ALTER TABLE organizational_unit DROP CONSTRAINT chk_org_unit_relation_type');
    await queryRunner.query('ALTER TABLE organizational_unit DROP COLUMN relation_type');
  }
}
