import type { MigrationInterface, QueryRunner } from 'typeorm';

export class Phase1RolesUsers1767225604000 implements MigrationInterface {
  name = 'Phase1RolesUsers1767225604000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE user_status ADD VALUE IF NOT EXISTS 'PENDING_ACTIVATION'
    `);

    await queryRunner.query(`
      ALTER TABLE role
        ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS password_reset_token (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
        token_hash  TEXT NOT NULL UNIQUE,
        expires_at  TIMESTAMPTZ NOT NULL,
        used_at     TIMESTAMPTZ,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_password_reset_token_user
        ON password_reset_token(user_id)
        WHERE used_at IS NULL
    `);

    await queryRunner.query(`
      INSERT INTO permission (code, module, resource_type, action, scope_level, description)
      VALUES
        ('role:read:global',   'USER', 'role', 'read',   'GLOBAL', 'Listar y consultar roles'),
        ('role:create:global', 'USER', 'role', 'create', 'GLOBAL', 'Crear roles'),
        ('role:manage:global', 'USER', 'role', 'manage', 'GLOBAL', 'Editar, eliminar y administrar permisos/SoD de roles'),
        ('user:read:global',   'USER', 'user', 'read',   'GLOBAL', 'Listar y consultar usuarios')
      ON CONFLICT (code) DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO role_permission (role_id, permission_id)
      SELECT r.id, p.id
      FROM role r
      JOIN permission p ON p.code IN (
        'role:read:global',
        'role:create:global',
        'role:manage:global',
        'user:read:global'
      )
      WHERE r.code = 'SUPER_ADMIN'
      ON CONFLICT DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM role_permission
      WHERE permission_id IN (
        SELECT id FROM permission
        WHERE code IN (
          'role:read:global',
          'role:create:global',
          'role:manage:global',
          'user:read:global'
        )
      )
    `);
    await queryRunner.query(`
      DELETE FROM permission
      WHERE code IN (
        'role:read:global',
        'role:create:global',
        'role:manage:global',
        'user:read:global'
      )
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS password_reset_token`);
    await queryRunner.query(`ALTER TABLE role DROP COLUMN IF EXISTS deleted_at`);
  }
}
