import type { MigrationInterface, QueryRunner } from 'typeorm';

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
