import type { MigrationInterface, QueryRunner } from 'typeorm';

export class UnitHeadCostCenterCode1767226030000 implements MigrationInterface {
  name = 'UnitHeadCostCenterCode1767226030000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE organizational_unit ADD COLUMN head_cost_center_code VARCHAR(20)');
    await queryRunner.query(`
      UPDATE organizational_unit u SET head_cost_center_code = left(cc.external_code, 20)
      FROM cost_center cc WHERE cc.id = u.head_cost_center_id
    `);
    await queryRunner.query(
      `ALTER TABLE organizational_unit ADD CONSTRAINT chk_org_unit_head_code
       CHECK (head_cost_center_id IS NULL OR head_cost_center_code IS NOT NULL)`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_org_unit_head_code_pending ON organizational_unit (head_cost_center_code)
       WHERE head_cost_center_id IS NULL AND head_cost_center_code IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [row] = (await queryRunner.query(
      `SELECT count(*)::int AS pending FROM organizational_unit
       WHERE head_cost_center_id IS NULL AND head_cost_center_code IS NOT NULL`,
    )) as Array<{ pending: number }>;
    if (row && row.pending > 0) {
      throw new Error(`No se puede revertir sin perder datos: ${row.pending} unidades con centro propio pendiente`);
    }
    await queryRunner.query('DROP INDEX idx_org_unit_head_code_pending');
    await queryRunner.query('ALTER TABLE organizational_unit DROP CONSTRAINT chk_org_unit_head_code');
    await queryRunner.query('ALTER TABLE organizational_unit DROP COLUMN head_cost_center_code');
  }
}
