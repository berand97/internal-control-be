import type { MigrationInterface, QueryRunner } from 'typeorm';

export class PermissionResourceLabelsEs1767225615000 implements MigrationInterface {
  name = 'PermissionResourceLabelsEs1767225615000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE permission
      ADD COLUMN resource_label VARCHAR(80)
    `);
    await queryRunner.query(`
      UPDATE permission
      SET resource_label = CASE resource_type
        WHEN 'asset' THEN 'Activos'
        WHEN 'audit_log' THEN 'Bitácora'
        WHEN 'building' THEN 'Edificios'
        WHEN 'campus' THEN 'Campus'
        WHEN 'category' THEN 'Categorías'
        WHEN 'cost_center' THEN 'Centros de costo'
        WHEN 'depreciation' THEN 'Depreciación'
        WHEN 'document_template' THEN 'Plantillas'
        WHEN 'feature' THEN 'Módulos'
        WHEN 'loan' THEN 'Préstamos'
        WHEN 'location' THEN 'Ubicaciones'
        WHEN 'navigation' THEN 'Menús'
        WHEN 'org_unit' THEN 'Organigrama'
        WHEN 'physical_inventory' THEN 'Tomas físicas'
        WHEN 'role' THEN 'Roles'
        WHEN 'storage' THEN 'Almacenamiento'
        WHEN 'user' THEN 'Usuarios'
        ELSE INITCAP(REPLACE(resource_type, '_', ' '))
      END
    `);
    await queryRunner.query(`
      ALTER TABLE permission
      ALTER COLUMN resource_label SET NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE permission DROP COLUMN resource_label
    `);
  }
}
