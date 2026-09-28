import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * La migración 1767225870000 otorgó inventory_catalog:manage:global también a SUPER_ADMIN, lo que contradice la regla
 * del sistema «SUPER_ADMIN sin permisos operativos» (1767225613000-restore-role-scoped-navigation). Esa migración
 * puede estar ya aplicada, así que no se edita: aquí se retira el permiso solo de SUPER_ADMIN; INTERNAL_CONTROL_DIRECTOR
 * lo conserva. down() lo vuelve a otorgar (idempotente).
 */

const PERMISSION_CODE = 'inventory_catalog:manage:global';

export class RevokeSuperAdminInventoryCatalog1767225895000 implements MigrationInterface {
  name = 'RevokeSuperAdminInventoryCatalog1767225895000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `
      DELETE FROM role_permission rp
      USING role r, permission p
      WHERE rp.role_id = r.id
        AND rp.permission_id = p.id
        AND r.code = 'SUPER_ADMIN'
        AND p.code = $1
    `,
      [PERMISSION_CODE],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `
      INSERT INTO role_permission (role_id, permission_id)
      SELECT r.id, p.id
      FROM role r
      JOIN permission p ON p.code = $1
      WHERE r.code = 'SUPER_ADMIN'
      ON CONFLICT DO NOTHING
    `,
      [PERMISSION_CODE],
    );
  }
}
