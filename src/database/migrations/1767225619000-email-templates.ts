import type { MigrationInterface, QueryRunner } from 'typeorm';

export class EmailTemplates1767225619000 implements MigrationInterface {
  name = 'EmailTemplates1767225619000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS email_template (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        template_type  VARCHAR(40) NOT NULL,
        version        INTEGER NOT NULL,
        subject        VARCHAR(200) NOT NULL,
        body           TEXT NOT NULL,
        placeholders   JSONB NOT NULL,
        is_active      BOOLEAN NOT NULL DEFAULT TRUE,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by     UUID,
        UNIQUE (template_type, version)
      )
    `);

    await queryRunner.query(`
      INSERT INTO email_template (template_type, version, subject, body, placeholders, is_active)
      VALUES
        (
          'USER_INVITATION',
          1,
          'Invitación a {{app.name}}',
          E'Se creó su cuenta en {{app.name}}.\n\nCorreo: {{user.email}}\nUsuario: {{user.username}}\nContraseña temporal: {{auth.temporaryPassword}}\n\nInicie sesión en {{auth.loginUrl}} y cambie la contraseña.',
          '["app.name","user.email","user.username","auth.temporaryPassword","auth.loginUrl"]'::jsonb,
          TRUE
        ),
        (
          'PASSWORD_RESET',
          1,
          'Restablecer contraseña — {{app.name}}',
          E'Hola {{user.email}},\n\nUse este enlace para restablecer su contraseña:\n{{auth.resetUrl}}\n\nEl enlace vence en {{auth.expiresInHours}} horas.',
          '["user.email","app.name","auth.resetUrl","auth.expiresInHours"]'::jsonb,
          TRUE
        ),
        (
          'GENERIC_NOTIFICATION',
          1,
          '{{notification.title}} — {{app.name}}',
          E'Hola {{user.email}},\n\n{{notification.message}}\n\n{{app.loginUrl}}',
          '["user.email","notification.title","app.name","notification.message","app.loginUrl"]'::jsonb,
          TRUE
        ),
        (
          'SYSTEM_ALERT',
          1,
          '[{{alert.severity}}] {{alert.title}}',
          '{{alert.message}}',
          '["alert.severity","alert.title","alert.message"]'::jsonb,
          TRUE
        ),
        (
          'LOAN_STATUS_NOTIFICATION',
          1,
          'Préstamo {{prestamo.estado}}',
          E'Hola {{user.email}},\nEl préstamo cambió a {{prestamo.estado}}.\nJustificación: {{prestamo.justificacion}}\n{{app.loginUrl}}',
          '["user.email","prestamo.estado","prestamo.justificacion","app.loginUrl"]'::jsonb,
          TRUE
        ),
        (
          'INVENTORY_ALERT',
          1,
          'Toma física: {{inventario.nombre}}',
          E'Hola {{user.email}},\n{{alerta.mensaje}}\n{{app.loginUrl}}',
          '["user.email","inventario.nombre","alerta.mensaje","app.loginUrl"]'::jsonb,
          TRUE
        )
      ON CONFLICT (template_type, version) DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS email_template`);
  }
}
