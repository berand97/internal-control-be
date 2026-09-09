import type { MigrationInterface, QueryRunner } from 'typeorm';

export class RoleSuperiorHierarchy1767225617000 implements MigrationInterface {
  name = 'RoleSuperiorHierarchy1767225617000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE role
      ADD COLUMN superior_role_id UUID REFERENCES role(id)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_role_superior ON role(superior_role_id)
    `);
    await queryRunner.query(`
      UPDATE role
      SET superior_role_id = (SELECT id FROM role WHERE code = 'SUPER_ADMIN')
      WHERE code = 'INTERNAL_CONTROL_DIRECTOR'
        AND deleted_at IS NULL
    `);
    await queryRunner.query(`
      UPDATE role
      SET superior_role_id = (SELECT id FROM role WHERE code = 'INTERNAL_CONTROL_DIRECTOR')
      WHERE code IN ('AUDITOR', 'DEPARTMENT_HEAD')
        AND deleted_at IS NULL
    `);
    await queryRunner.query(`
      UPDATE role
      SET superior_role_id = (SELECT id FROM role WHERE code = 'AUDITOR')
      WHERE code = 'VIEWER'
        AND deleted_at IS NULL
    `);
    await queryRunner.query(`
      UPDATE role
      SET superior_role_id = (SELECT id FROM role WHERE code = 'DEPARTMENT_HEAD')
      WHERE code = 'CUSTODIAN'
        AND deleted_at IS NULL
    `);
    await queryRunner.query(`
      UPDATE role child
      SET superior_role_id = (
        SELECT parent.id
        FROM role parent
        WHERE parent.deleted_at IS NULL
          AND parent.hierarchy_level = child.hierarchy_level - 1
        ORDER BY CASE WHEN parent.code = 'SUPER_ADMIN' THEN 0 ELSE 1 END, parent.name
        LIMIT 1
      )
      WHERE child.is_system = FALSE
        AND child.deleted_at IS NULL
        AND child.superior_role_id IS NULL
        AND child.hierarchy_level > 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_role_superior`);
    await queryRunner.query(`ALTER TABLE role DROP COLUMN IF EXISTS superior_role_id`);
  }
}
