import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Decisión del desarrollador: SUPER_ADMIN también administra las plantillas de correo. La migración 1767225800000
 * sembró email_template:read:global y email_template:manage:global solo a INTERNAL_CONTROL_DIRECTOR y puede estar ya
 * aplicada, así que no se edita: aquí se otorgan ambos permisos a SUPER_ADMIN (idempotente, ON CONFLICT DO NOTHING).
 * down() los retira solo de SUPER_ADMIN; el director conserva los suyos. TypeORM corre cada migración en una
 * transacción (CLI: 'all'; tests: 'each').
 */

const PERMISSION_CODES = ['email_template:read:global', 'email_template:manage:global'] as const;

export class EmailTemplatesSuperAdmin1767225810000 implements MigrationInterface {
  name = 'EmailTemplatesSuperAdmin1767225810000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `
      INSERT INTO role_permission (role_id, permission_id)
      SELECT r.id, p.id
      FROM role r
      JOIN permission p ON p.code = ANY($1::text[])
      WHERE r.code = 'SUPER_ADMIN'
      ON CONFLICT DO NOTHING
    `,
      [PERMISSION_CODES],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `
      DELETE FROM role_permission rp
      USING role r, permission p
      WHERE rp.role_id = r.id
        AND rp.permission_id = p.id
        AND r.code = 'SUPER_ADMIN'
        AND p.code = ANY($1::text[])
    `,
      [PERMISSION_CODES],
    );
  }
}
