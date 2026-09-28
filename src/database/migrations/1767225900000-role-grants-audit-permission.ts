import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Permiso de solo lectura para consultar el historial de otorgamientos (GET /roles/grants-history): quién dio o quitó
 * qué permiso a qué rol, qué rol a qué usuario, cuándo, desde dónde y por qué. La Directora de Control Interno y el
 * Auditor lo consultan sin tener administración de roles; SUPER_ADMIN también (ya lee la bitácora con
 * audit:read:global). No otorga ningún permiso operativo ni de administración.
 */

const PERMISSION_CODE = 'role:audit:global';

export class RoleGrantsAuditPermission1767225900000 implements MigrationInterface {
  name = 'RoleGrantsAuditPermission1767225900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `
      INSERT INTO permission
        (code, module, resource_type, resource_label, action, scope_level, description, is_system)
      VALUES
        ($1, 'USER', 'role', 'Roles', 'audit', 'GLOBAL', 'Ver historial de permisos otorgados', TRUE)
      ON CONFLICT (code) DO NOTHING
    `,
      [PERMISSION_CODE],
    );
    await queryRunner.query(
      `
      INSERT INTO role_permission (role_id, permission_id)
      SELECT r.id, p.id
      FROM role r
      JOIN permission p ON p.code = $1
      WHERE r.code IN ('INTERNAL_CONTROL_DIRECTOR', 'AUDITOR', 'SUPER_ADMIN')
        AND r.deleted_at IS NULL
      ON CONFLICT DO NOTHING
    `,
      [PERMISSION_CODE],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM role_permission WHERE permission_id IN (SELECT id FROM permission WHERE code = $1)`,
      [PERMISSION_CODE],
    );
    await queryRunner.query(`DELETE FROM permission WHERE code = $1`, [PERMISSION_CODE]);
  }
}
