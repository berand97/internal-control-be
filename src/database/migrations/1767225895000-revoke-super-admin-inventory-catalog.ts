import type { MigrationInterface, QueryRunner } from 'typeorm';

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
