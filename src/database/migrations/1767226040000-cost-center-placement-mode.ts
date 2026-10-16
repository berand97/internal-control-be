import type { MigrationInterface, QueryRunner } from 'typeorm';

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
