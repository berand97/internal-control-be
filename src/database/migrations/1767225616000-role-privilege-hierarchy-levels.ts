import type { MigrationInterface, QueryRunner } from 'typeorm';

export class RolePrivilegeHierarchyLevels1767225616000 implements MigrationInterface {
  name = 'RolePrivilegeHierarchyLevels1767225616000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE role
      SET hierarchy_level = CASE code
        WHEN 'SUPER_ADMIN' THEN 0
        WHEN 'INTERNAL_CONTROL_DIRECTOR' THEN 1
        WHEN 'AUDITOR' THEN 2
        WHEN 'DEPARTMENT_HEAD' THEN 2
        WHEN 'CUSTODIAN' THEN 3
        WHEN 'VIEWER' THEN 3
        ELSE hierarchy_level
      END
      WHERE deleted_at IS NULL
    `);
    await queryRunner.query(`
      WITH RECURSIVE ranked AS (
        SELECT id, parent_role_id, hierarchy_level
        FROM role
        WHERE is_system = TRUE
          AND deleted_at IS NULL
        UNION ALL
        SELECT child.id, child.parent_role_id, CAST(ranked.hierarchy_level + 1 AS SMALLINT)
        FROM role child
        JOIN ranked ON child.parent_role_id = ranked.id
        WHERE child.is_system = FALSE
          AND child.deleted_at IS NULL
      )
      UPDATE role
      SET hierarchy_level = ranked.hierarchy_level
      FROM ranked
      WHERE role.id = ranked.id
        AND role.is_system = FALSE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE role
      SET hierarchy_level = 0
      WHERE deleted_at IS NULL
    `);
  }
}
