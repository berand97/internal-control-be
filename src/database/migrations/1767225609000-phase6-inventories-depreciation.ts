import type { MigrationInterface, QueryRunner } from 'typeorm';

export class Phase6InventoriesDepreciation1767225609000
  implements MigrationInterface
{
  name = 'Phase6InventoriesDepreciation1767225609000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE physical_inventory
        ADD COLUMN IF NOT EXISTS scope_type VARCHAR(20) NOT NULL DEFAULT 'COST_CENTER',
        ADD COLUMN IF NOT EXISTS scope_id UUID,
        ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS closed_by UUID REFERENCES app_user(id),
        ADD COLUMN IF NOT EXISTS reconcile_requested_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS reconcile_requested_by UUID REFERENCES app_user(id),
        ADD COLUMN IF NOT EXISTS reconcile_approved_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS reconcile_approved_by UUID REFERENCES app_user(id),
        ADD COLUMN IF NOT EXISTS discrepancy_report JSONB
    `);

    await queryRunner.query(`
      ALTER TABLE physical_inventory_item
        ADD COLUMN IF NOT EXISTS expected_cost_center_id UUID REFERENCES cost_center(id),
        ADD COLUMN IF NOT EXISTS is_on_loan BOOLEAN NOT NULL DEFAULT FALSE
    `);

    await queryRunner.query(`
      ALTER TABLE physical_inventory_item
        ALTER COLUMN verification_result SET DEFAULT 'PENDING'
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_inv_open_scope
        ON physical_inventory(scope_type, scope_id)
        WHERE status IN ('PLANNED', 'IN_PROGRESS')
    `);

    await queryRunner.query(`
      INSERT INTO permission (code, module, resource_type, action, scope_level, description) VALUES
        ('inventory:read:global', 'INVENTORY', 'physical_inventory', 'read', 'GLOBAL', 'Consultar tomas físicas'),
        ('inventory:reconcile:global', 'INVENTORY', 'physical_inventory', 'approve', 'GLOBAL', 'Aprobar reconciliación de toma física'),
        ('depreciation:read:global', 'ASSET', 'depreciation', 'read', 'GLOBAL', 'Consultar snapshots de depreciación'),
        ('depreciation:calculate:global', 'ASSET', 'depreciation', 'create', 'GLOBAL', 'Calcular depreciación de un período')
      ON CONFLICT (code) DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO role_permission (role_id, permission_id)
      SELECT r.id, p.id
      FROM role r
      JOIN permission p ON p.code IN (
        'inventory:read:global',
        'inventory:create:global',
        'inventory:execute:global',
        'inventory:reconcile:global',
        'depreciation:read:global',
        'depreciation:calculate:global'
      )
      WHERE r.code IN ('SUPER_ADMIN', 'INTERNAL_CONTROL_DIRECTOR')
      ON CONFLICT DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO role_permission (role_id, permission_id)
      SELECT r.id, p.id FROM role r, permission p
      WHERE r.code = 'AUDITOR' AND p.code IN (
        'inventory:read:global',
        'depreciation:read:global'
      )
      ON CONFLICT DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO role_permission (role_id, permission_id)
      SELECT r.id, p.id FROM role r, permission p
      WHERE r.code IN ('DEPARTMENT_HEAD', 'CUSTODIAN')
        AND p.code IN ('inventory:read:global', 'inventory:execute:global')
      ON CONFLICT DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM role_permission
      WHERE permission_id IN (
        SELECT id FROM permission WHERE code IN (
          'inventory:read:global',
          'inventory:reconcile:global',
          'depreciation:read:global',
          'depreciation:calculate:global'
        )
      )
    `);
    await queryRunner.query(`
      DELETE FROM permission WHERE code IN (
        'inventory:read:global',
        'inventory:reconcile:global',
        'depreciation:read:global',
        'depreciation:calculate:global'
      )
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_inv_open_scope`);
  }
}
