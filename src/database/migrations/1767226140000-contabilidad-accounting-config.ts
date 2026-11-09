import type { MigrationInterface, QueryRunner } from 'typeorm';

const ACCOUNTING_ROLE = 'CONTABILIDAD';
const DIRECTOR_ROLE = 'INTERNAL_CONTROL_DIRECTOR';
const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';

const CONFIGURE = 'depreciation:configure:global';
const CLOSE = 'depreciation:close:global';
const REOPEN = 'depreciation:reopen:global';
const READ = 'depreciation:read:global';
const CALCULATE = 'depreciation:calculate:global';
const CATEGORY_READ = 'category:read:global';
const ASSET_READ = 'asset:read:global';

const ACCOUNTING_PERMISSIONS = [READ, CALCULATE, CONFIGURE, CLOSE, CATEGORY_READ, ASSET_READ] as const;
const ADMIN_EXTRA = [CONFIGURE, CLOSE, REOPEN] as const;

export class ContabilidadAccountingConfig1767226140000 implements MigrationInterface {
  name = 'ContabilidadAccountingConfig1767226140000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `
      INSERT INTO permission
        (code, module, resource_type, resource_label, action, scope_level, description, is_system)
      VALUES
        ($1, 'ASSET', 'depreciation', 'Depreciación', 'update', 'GLOBAL',
         'Configurar años de vida útil, método y valor residual (categoría y activo)', TRUE),
        ($2, 'ASSET', 'depreciation', 'Depreciación', 'close', 'GLOBAL',
         'Cerrar un período de depreciación', TRUE),
        ($3, 'ASSET', 'depreciation', 'Depreciación', 'reopen', 'GLOBAL',
         'Reabrir un período de depreciación cerrado', TRUE)
      ON CONFLICT (code) DO NOTHING
    `,
      [CONFIGURE, CLOSE, REOPEN],
    );

    await queryRunner.query(
      `
      INSERT INTO role (code, name, description, is_system, is_assignable, hierarchy_level, superior_role_id)
      SELECT $1, 'Contabilidad',
             'Configura depreciación (años, método, valor residual), calcula y cierra períodos; firma actas por Contabilidad',
             TRUE, TRUE, 2,
             (SELECT id FROM role WHERE code = $2 AND deleted_at IS NULL)
      ON CONFLICT (code) DO UPDATE
        SET description = EXCLUDED.description,
            name = EXCLUDED.name,
            updated_at = NOW()
    `,
      [ACCOUNTING_ROLE, DIRECTOR_ROLE],
    );

    await queryRunner.query(
      `
      INSERT INTO role_permission (role_id, permission_id)
      SELECT r.id, p.id
      FROM role r
      JOIN permission p ON p.code = ANY($2::text[])
      WHERE r.code = $1 AND r.deleted_at IS NULL
      ON CONFLICT DO NOTHING
    `,
      [ACCOUNTING_ROLE, [...ACCOUNTING_PERMISSIONS]],
    );

    await queryRunner.query(
      `
      INSERT INTO role_permission (role_id, permission_id)
      SELECT r.id, p.id
      FROM role r
      JOIN permission p ON p.code = ANY($2::text[])
      WHERE r.code = ANY($1::text[]) AND r.deleted_at IS NULL
      ON CONFLICT DO NOTHING
    `,
      [[SUPER_ADMIN_ROLE, DIRECTOR_ROLE], [...ADMIN_EXTRA]],
    );

    await queryRunner.query(
      `
      INSERT INTO role_separation_of_duties (role_a_id, role_b_id, constraint_type, reason)
      SELECT a.id, b.id, 'STATIC',
             'Quien configura y cierra depreciación no puede firmar como Control Interno'
      FROM role a, role b
      WHERE a.code = $1 AND b.code = $2
        AND a.deleted_at IS NULL AND b.deleted_at IS NULL
      ON CONFLICT DO NOTHING
    `,
      [ACCOUNTING_ROLE, DIRECTOR_ROLE],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `
      DELETE FROM role_separation_of_duties
      WHERE role_a_id = (SELECT id FROM role WHERE code = $1)
        AND role_b_id = (SELECT id FROM role WHERE code = $2)
    `,
      [ACCOUNTING_ROLE, DIRECTOR_ROLE],
    );

    const codes = [CONFIGURE, CLOSE, REOPEN];
    await queryRunner.query(
      `
      DELETE FROM role_permission
      WHERE permission_id IN (SELECT id FROM permission WHERE code = ANY($1::text[]))
    `,
      [codes],
    );
    await queryRunner.query(
      `
      DELETE FROM role_permission
      WHERE role_id = (SELECT id FROM role WHERE code = $1)
        AND permission_id IN (
          SELECT id FROM permission WHERE code = ANY($2::text[])
        )
    `,
      [ACCOUNTING_ROLE, [READ, CALCULATE, CATEGORY_READ, ASSET_READ]],
    );
    await queryRunner.query(`DELETE FROM permission WHERE code = ANY($1::text[])`, [codes]);
    await queryRunner.query(
      `
      UPDATE role
      SET description = 'Revisa y firma por Contabilidad las actas de traslado de activos (OCI-17-89)',
          updated_at = NOW()
      WHERE code = $1
    `,
      [ACCOUNTING_ROLE],
    );
  }
}
