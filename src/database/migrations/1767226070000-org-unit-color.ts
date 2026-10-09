import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Color base de cada rama del organigrama.
 *
 * - organizational_unit.color: #rrggbb en minúsculas (chk_org_unit_color); null = hereda el de su jefe. El frontend
 *   pinta las dependencias con tonos más suaves del mismo color.
 * - org_structure_history admite el campo COLOR (cambios de color desde la pantalla o el Excel).
 * - No se siembra ningún color.
 *
 * down(): se niega si hay unidades con color o historial de color (se perderían).
 */
export class OrgUnitColor1767226070000 implements MigrationInterface {
  name = 'OrgUnitColor1767226070000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE organizational_unit ADD COLUMN color VARCHAR(7)');
    await queryRunner.query(
      `ALTER TABLE organizational_unit ADD CONSTRAINT chk_org_unit_color CHECK (color ~ '^#[0-9a-f]{6}$')`,
    );
    await queryRunner.query('ALTER TABLE org_structure_history DROP CONSTRAINT chk_org_history_field');
    await queryRunner.query(
      `ALTER TABLE org_structure_history ADD CONSTRAINT chk_org_history_field CHECK (field IN
       ('NAME', 'CODE', 'TYPE', 'PARENT', 'PREFIX', 'RELATION', 'HEAD_COST_CENTER', 'STATUS', 'COLOR'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [row] = (await queryRunner.query(
      `SELECT (SELECT count(*) FROM organizational_unit WHERE color IS NOT NULL)::int AS colored,
              (SELECT count(*) FROM org_structure_history WHERE field = 'COLOR')::int AS history`,
    )) as Array<{ colored: number; history: number }>;
    if (row && (row.colored > 0 || row.history > 0)) {
      throw new Error(
        `No se puede revertir sin perder datos: ${row.colored} unidades con color y ${row.history} cambios de color en el historial`,
      );
    }
    await queryRunner.query('ALTER TABLE org_structure_history DROP CONSTRAINT chk_org_history_field');
    await queryRunner.query(
      `ALTER TABLE org_structure_history ADD CONSTRAINT chk_org_history_field CHECK (field IN
       ('NAME', 'CODE', 'TYPE', 'PARENT', 'PREFIX', 'RELATION', 'HEAD_COST_CENTER', 'STATUS'))`,
    );
    await queryRunner.query('ALTER TABLE organizational_unit DROP CONSTRAINT chk_org_unit_color');
    await queryRunner.query('ALTER TABLE organizational_unit DROP COLUMN color');
  }
}
