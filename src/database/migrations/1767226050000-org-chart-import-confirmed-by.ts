import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Excel del organigrama a prueba de archivos viejos.
 *
 * - org_chart_import.confirmed_by: quién confirmó la importación (la previsualización ya guardaba file_sha256, el hash
 *   del contenido). Con eso la previsualización avisa «Este archivo ya se aplicó el … por …».
 *   Las confirmadas antes de esta migración quedan con confirmed_by = created_by (quien previsualizó; hasta hoy
 *   confirmaba la misma persona en el mismo paso).
 * - idx_org_chart_import_confirmed_sha: búsqueda por hash entre las confirmadas.
 *
 * down(): quita la columna y el índice (no se pierde nada que no se pueda deducir de created_by).
 */
export class OrgChartImportConfirmedBy1767226050000 implements MigrationInterface {
  name = 'OrgChartImportConfirmedBy1767226050000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE org_chart_import ADD COLUMN confirmed_by UUID REFERENCES app_user(id)');
    await queryRunner.query(`UPDATE org_chart_import SET confirmed_by = created_by WHERE status = 'CONFIRMED'`);
    await queryRunner.query(
      `CREATE INDEX idx_org_chart_import_confirmed_sha ON org_chart_import (file_sha256, confirmed_at DESC)
       WHERE status = 'CONFIRMED'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX idx_org_chart_import_confirmed_sha');
    await queryRunner.query('ALTER TABLE org_chart_import DROP COLUMN confirmed_by');
  }
}
