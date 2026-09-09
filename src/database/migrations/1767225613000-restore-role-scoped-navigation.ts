import type { MigrationInterface, QueryRunner } from 'typeorm';

const SUPER_ADMIN_KEEP = [
  'user:read:global',
  'user:manage:global',
  'role:read:global',
  'role:create:global',
  'role:manage:global',
  'role:assign:global',
  'audit:read:global',
  'audit:export:global',
  'feature:manage:global',
  'storage:manage:global',
] as const;

const BROADCAST_READS = [
  'campus:read:global',
  'building:read:global',
  'location:read:global',
  'org_unit:read:global',
  'cost_center:read:global',
  'category:read:global',
  'asset:read:global',
] as const;

const SUPER_ADMIN_OPERATIONAL = [
  'campus:read:global',
  'campus:manage:global',
  'building:read:global',
  'building:manage:global',
  'location:read:global',
  'location:manage:global',
  'org_unit:read:global',
  'org_unit:manage:global',
  'cost_center:read:global',
  'cost_center:manage:global',
  'category:read:global',
  'category:manage:global',
  'asset:read:global',
  'asset:create:global',
  'asset:update:global',
  'asset:write_off:global',
  'asset:sign_qr:global',
  'asset:export:global',
  'loan:read:global',
  'loan:request:own',
  'loan:approve:global',
  'loan:update:global',
  'document_template:read:global',
  'document_template:update:global',
  'inventory:read:global',
  'inventory:create:global',
  'inventory:execute:global',
  'inventory:reconcile:global',
  'depreciation:read:global',
  'depreciation:calculate:global',
] as const;

const sqlList = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

export class RestoreRoleScopedNavigation1767225613000 implements MigrationInterface {
  name = 'RestoreRoleScopedNavigation1767225613000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM role_permission rp
      USING role r, permission p
      WHERE rp.role_id = r.id
        AND rp.permission_id = p.id
        AND r.code = 'SUPER_ADMIN'
        AND p.code NOT IN (${sqlList(SUPER_ADMIN_KEEP)})
    `);

    await queryRunner.query(`
      DELETE FROM role_permission rp
      USING role r, permission p
      WHERE rp.role_id = r.id
        AND rp.permission_id = p.id
        AND r.code IN ('VIEWER', 'CUSTODIAN', 'DEPARTMENT_HEAD')
        AND p.code IN (${sqlList(BROADCAST_READS)})
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO role_permission (role_id, permission_id)
      SELECT r.id, p.id
      FROM role r
      JOIN permission p ON p.code IN (${sqlList(BROADCAST_READS)})
      ON CONFLICT DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO role_permission (role_id, permission_id)
      SELECT r.id, p.id
      FROM role r
      JOIN permission p ON p.code IN (${sqlList(SUPER_ADMIN_OPERATIONAL)})
      WHERE r.code = 'SUPER_ADMIN'
      ON CONFLICT DO NOTHING
    `);
  }
}
