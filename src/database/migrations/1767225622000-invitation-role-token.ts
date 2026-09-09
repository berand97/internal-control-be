import type { MigrationInterface, QueryRunner } from 'typeorm';

export class InvitationRoleToken1767225622000 implements MigrationInterface {
  name = 'InvitationRoleToken1767225622000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE email_template
      SET
        body = E'Se creó su cuenta en {{app.name}}.\n\nRol: {{user.role}}\nCorreo: {{user.email}}\nUsuario: {{user.username}}\nContraseña temporal: {{auth.temporaryPassword}}\n\nInicie sesión en {{auth.loginUrl}} y cambie la contraseña.',
        placeholders = '["app.name","user.role","user.email","user.username","auth.temporaryPassword","auth.loginUrl"]'::jsonb
      WHERE template_type = 'USER_INVITATION'
        AND is_active = TRUE
        AND body NOT LIKE '%{{user.role}}%'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE email_template
      SET
        body = replace(body, E'Rol: {{user.role}}\n', ''),
        placeholders = placeholders - 'user.role'
      WHERE template_type = 'USER_INVITATION'
        AND body LIKE '%{{user.role}}%'
    `);
  }
}
