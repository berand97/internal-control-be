import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Ubicación manual o automática de los centros de costo, y origen AUTO del conciliador de estructura.
 *
 * - cost_center_placement.mode: AUTO (la unidad y el padre los decide el código: prefijo más largo y XYZ0) o MANUAL
 *   (una persona fijó la unidad o el padre en la pantalla del centro; el conciliador no la toca y la lista como
 *   excepción). La fila vigente manda; las cerradas guardan la marca que tuvieron.
 * - Datos existentes: AUTO, salvo las filas que salieron de un cambio hecho por una persona en POST
 *   /cost-centers/:id/placement. Se reconocen porque son source MANUAL y no son la primera fila de su centro (el alta
 *   manual también es MANUAL, pero es la primera). Las importaciones (IMPORT) y la migración inicial quedan AUTO.
 * - source admite AUTO: placements escritos por el conciliador (sin importación asociada).
 * - org_structure_history.source admite AUTO: amarres del centro propio hechos por el conciliador.
 *
 * down(): se niega si hay filas con origen AUTO (se perdería de dónde salieron); la marca mode se descarta.
 */
export class CostCenterPlacementMode1767226040000 implements MigrationInterface {
  name = 'CostCenterPlacementMode1767226040000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE cost_center_placement ADD COLUMN mode VARCHAR(10) NOT NULL DEFAULT 'AUTO'`);
    await queryRunner.query(
      `ALTER TABLE cost_center_placement ADD CONSTRAINT chk_cc_placement_mode CHECK (mode IN ('AUTO', 'MANUAL'))`,
    );
    await queryRunner.query(`
      UPDATE cost_center_placement p SET mode = 'MANUAL'
      WHERE p.source = 'MANUAL'
        AND EXISTS (SELECT 1 FROM cost_center_placement prev
                    WHERE prev.cost_center_id = p.cost_center_id AND prev.valid_from < p.valid_from)
    `);
    await queryRunner.query('ALTER TABLE cost_center_placement DROP CONSTRAINT chk_cc_placement_source');
    await queryRunner.query(
      `ALTER TABLE cost_center_placement ADD CONSTRAINT chk_cc_placement_source
       CHECK (source IN ('MANUAL', 'IMPORT', 'MIGRATION', 'AUTO'))`,
    );
    await queryRunner.query('ALTER TABLE org_structure_history DROP CONSTRAINT chk_org_history_source');
    await queryRunner.query(
      `ALTER TABLE org_structure_history ADD CONSTRAINT chk_org_history_source CHECK (source IN ('MANUAL', 'IMPORT', 'AUTO'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [row] = (await queryRunner.query(`
      SELECT (SELECT count(*) FROM cost_center_placement WHERE source = 'AUTO')::int AS placements,
             (SELECT count(*) FROM org_structure_history WHERE source = 'AUTO')::int AS history
    `)) as Array<{ placements: number; history: number }>;
    if (row && (row.placements > 0 || row.history > 0)) {
      throw new Error(
        `No se puede revertir sin perder datos: ${row.placements} ubicaciones y ${row.history} eventos del historial ` +
          'escritos por el conciliador de estructura',
      );
    }
    await queryRunner.query('ALTER TABLE org_structure_history DROP CONSTRAINT chk_org_history_source');
    await queryRunner.query(
      `ALTER TABLE org_structure_history ADD CONSTRAINT chk_org_history_source CHECK (source IN ('MANUAL', 'IMPORT'))`,
    );
    await queryRunner.query('ALTER TABLE cost_center_placement DROP CONSTRAINT chk_cc_placement_source');
    await queryRunner.query(
      `ALTER TABLE cost_center_placement ADD CONSTRAINT chk_cc_placement_source
       CHECK (source IN ('MANUAL', 'IMPORT', 'MIGRATION'))`,
    );
    await queryRunner.query('ALTER TABLE cost_center_placement DROP CONSTRAINT chk_cc_placement_mode');
    await queryRunner.query('ALTER TABLE cost_center_placement DROP COLUMN mode');
  }
}
