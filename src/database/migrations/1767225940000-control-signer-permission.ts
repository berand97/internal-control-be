import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Los roles se definen por permisos, no por nombre (decisión del desarrollador).
 *
 * 1. Permiso act:sign_control:global («Actas» / sign_control): firmar actas por Control Interno. Decide quién puede
 *    firmar el turno CONTROL_INTERNO del traslado (OCI-17-89) y quién puede ser sustituto de un turno de Control
 *    Interno en cualquier acta; antes se decidía por los códigos de rol INTERNAL_CONTROL_DIRECTOR y AUDITOR. Se siembra
 *    solo a INTERNAL_CONTROL_DIRECTOR; el SUPER_ADMIN lo otorga a otros roles desde la interfaz. Está en la lista de
 *    permisos que exigen MFA (src/modules/auth/services/mfa-policy.ts).
 * 2. Revierte dos semillas al AUDITOR que nadie pidió: asset_request:review:global (1767225930000) y role:audit:global
 *    (1767225900000) quedan solo en INTERNAL_CONTROL_DIRECTOR (role:audit:global también en SUPER_ADMIN, que ya lo tenía).
 *
 * down(): quita el permiso nuevo (y sus asignaciones) y devuelve al AUDITOR las dos filas borradas.
 */

const CONTROL_SIGNER_PERMISSION = 'act:sign_control:global';
const AUDITOR_REVERTED = ['asset_request:review:global', 'role:audit:global'];

export class ControlSignerPermission1767225940000 implements MigrationInterface {
  name = 'ControlSignerPermission1767225940000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `
      INSERT INTO permission (code, module, resource_type, resource_label, action, scope_level, description, is_system)
      VALUES ($1, 'ASSET', 'act', 'Actas', 'sign_control', 'GLOBAL', 'Firmar actas por Control Interno', TRUE)
      ON CONFLICT (code) DO NOTHING
    `,
      [CONTROL_SIGNER_PERMISSION],
    );
    await queryRunner.query(
      `
      INSERT INTO role_permission (role_id, permission_id)
      SELECT r.id, p.id FROM role r JOIN permission p ON p.code = $1
      WHERE r.code = 'INTERNAL_CONTROL_DIRECTOR' AND r.deleted_at IS NULL
      ON CONFLICT DO NOTHING
    `,
      [CONTROL_SIGNER_PERMISSION],
    );
    await queryRunner.query(
      `
      DELETE FROM role_permission
      WHERE role_id IN (SELECT id FROM role WHERE code = 'AUDITOR')
        AND permission_id IN (SELECT id FROM permission WHERE code = ANY($1))
    `,
      [AUDITOR_REVERTED],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `
      INSERT INTO role_permission (role_id, permission_id)
      SELECT r.id, p.id FROM role r JOIN permission p ON p.code = ANY($1)
      WHERE r.code = 'AUDITOR' AND r.deleted_at IS NULL
      ON CONFLICT DO NOTHING
    `,
      [AUDITOR_REVERTED],
    );
    await queryRunner.query(
      `DELETE FROM role_permission WHERE permission_id IN (SELECT id FROM permission WHERE code = $1)`,
      [CONTROL_SIGNER_PERMISSION],
    );
    await queryRunner.query(`DELETE FROM permission WHERE code = $1`, [CONTROL_SIGNER_PERMISSION]);
  }
}
