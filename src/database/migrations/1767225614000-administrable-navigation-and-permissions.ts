import type { MigrationInterface, QueryRunner } from 'typeorm';

const sqlList = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

const ROLE_DEFAULTS: ReadonlyArray<{
  readonly role: string;
  readonly permissions: readonly string[];
}> = [
  {
    role: 'SUPER_ADMIN',
    permissions: [
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
      'navigation:manage:global',
    ],
  },
  {
    role: 'INTERNAL_CONTROL_DIRECTOR',
    permissions: [
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
    ],
  },
  {
    role: 'AUDITOR',
    permissions: [
      'campus:read:global',
      'building:read:global',
      'location:read:global',
      'org_unit:read:global',
      'cost_center:read:global',
      'category:read:global',
      'asset:read:global',
      'asset:export:global',
      'loan:read:global',
      'document_template:read:global',
      'inventory:read:global',
      'depreciation:read:global',
      'audit:read:global',
      'audit:export:global',
    ],
  },
  {
    role: 'VIEWER',
    permissions: ['asset:read:org_unit', 'loan:read:org_unit'],
  },
  {
    role: 'CUSTODIAN',
    permissions: [
      'asset:read:org_unit',
      'loan:read:org_unit',
      'loan:request:own',
      'inventory:read:global',
      'inventory:execute:global',
    ],
  },
  {
    role: 'DEPARTMENT_HEAD',
    permissions: [
      'asset:read:org_unit',
      'asset:update:org_unit',
      'loan:read:org_unit',
      'loan:request:own',
      'loan:approve:org_unit',
      'inventory:read:global',
      'inventory:execute:global',
    ],
  },
];

export class AdministrableNavigationAndPermissions1767225614000 implements MigrationInterface {
  name = 'AdministrableNavigationAndPermissions1767225614000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE permission
        ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT TRUE
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS navigation_item (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        module           VARCHAR(50) NOT NULL,
        module_label     VARCHAR(80) NOT NULL,
        resource         VARCHAR(50) NOT NULL,
        path             VARCHAR(200) NOT NULL UNIQUE,
        label            VARCHAR(80) NOT NULL,
        required_action  VARCHAR(30) NOT NULL,
        sort_order       INTEGER NOT NULL DEFAULT 0,
        is_active        BOOLEAN NOT NULL DEFAULT TRUE,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      INSERT INTO navigation_item
        (module, module_label, resource, path, label, required_action, sort_order)
      VALUES
        ('USER', 'Administración', 'user', '/users', 'Usuarios', 'read', 10),
        ('USER', 'Administración', 'role', '/roles', 'Roles y permisos', 'read', 20),
        ('STRUCTURE', 'Estructura', 'campus', '/campus', 'Campus y ubicaciones', 'read', 30),
        ('STRUCTURE', 'Estructura', 'org_unit', '/organizational-units', 'Organigrama', 'read', 40),
        ('STRUCTURE', 'Estructura', 'cost_center', '/cost-centers', 'Centros de costo', 'read', 50),
        ('ASSET', 'Activos', 'category', '/categories', 'Categorías', 'read', 60),
        ('ASSET', 'Activos', 'asset', '/assets', 'Activos', 'read', 70),
        ('INVENTORY', 'Inventarios', 'physical_inventory', '/inventories', 'Tomas físicas', 'read', 75),
        ('ASSET', 'Activos', 'loan', '/loans', 'Préstamos', 'read', 80),
        ('ASSET', 'Activos', 'depreciation', '/depreciation', 'Depreciación', 'read', 85),
        ('ASSET', 'Activos', 'document_template', '/document-templates', 'Plantillas', 'read', 90),
        ('SYSTEM', 'Sistema', 'storage', '/storage', 'Almacenamiento', 'update', 100),
        ('SYSTEM', 'Sistema', 'feature', '/features', 'Módulos', 'manage', 110),
        ('SYSTEM', 'Sistema', 'navigation', '/navigation', 'Menús', 'manage', 120)
      ON CONFLICT (path) DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO permission (code, module, resource_type, action, scope_level, description, is_system)
      VALUES (
        'navigation:manage:global',
        'SYSTEM',
        'navigation',
        'manage',
        'GLOBAL',
        'Administrar ítems del menú',
        TRUE
      )
      ON CONFLICT (code) DO NOTHING
    `);

    for (const entry of ROLE_DEFAULTS) {
      await queryRunner.query(`
        INSERT INTO role_permission (role_id, permission_id)
        SELECT r.id, p.id
        FROM role r
        JOIN permission p ON p.code IN (${sqlList(entry.permissions)})
        WHERE r.code = '${entry.role}'
        ON CONFLICT DO NOTHING
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM role_permission
      WHERE permission_id IN (
        SELECT id FROM permission WHERE code = 'navigation:manage:global'
      )
    `);
    await queryRunner.query(`
      DELETE FROM permission WHERE code = 'navigation:manage:global'
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS navigation_item`);
    await queryRunner.query(`
      ALTER TABLE permission DROP COLUMN IF EXISTS is_system
    `);
  }
}
