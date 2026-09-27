import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Plantillas de correo por bloques, como módulo propio (src/modules/email-templates).
 *
 * - email_template.blocks (JSONB, NOT NULL): cada versión existente (texto) se convierte en bloques `paragraph`, uno
 *   por párrafo (separados por una línea en blanco), preservando las variables {{...}} y los saltos de línea
 *   internos. La columna `body` se conserva, ahora nullable y sin mapear, con el texto original: down() lo devuelve
 *   intacto. Las versiones creadas después de up() no tienen body; down() se lo arma desde los bloques.
 * - activated_at / activated_by: quién activó la versión (antes activar sobrescribía created_by).
 * - uq_email_template_active: una sola versión activa por tipo. Si hubiera varias activas (guardados concurrentes
 *   de antes), queda activa la de mayor versión.
 * - mail_outbox.template_version_id: correo de prueba de una versión concreta.
 * - Permisos email_template:read:global y email_template:manage:global ("Plantillas de correo" en la matriz de
 *   Roles y permisos), otorgados solo a INTERNAL_CONTROL_DIRECTOR, que los delega. SUPER_ADMIN no los recibe.
 * - Menú: "Plantillas de correo" (/email-templates, email_template:read, ícono `mail`), id fijo y ON CONFLICT (path)
 *   DO NOTHING; down() borra por ese id y nunca toca una fila creada a mano.
 *
 * La conversión texto → bloques está copiada aquí (una migración no importa código vivo).
 */

const NAV_ID = '6f1d2c3a-7b4e-4a1f-9c2d-000000018001';
const PERMISSION_CODES = ['email_template:read:global', 'email_template:manage:global'] as const;

interface MigratedBlock {
  readonly type: string;
  readonly text?: string;
  readonly label?: string;
  readonly url?: string;
  readonly tone?: string;
  readonly size?: string;
  readonly items?: ReadonlyArray<{ readonly label: string; readonly value: string }>;
}

/** Texto de la plantilla anterior → un `paragraph` por párrafo. Unir los textos con "\n\n" devuelve el original. */
export const legacyBodyToBlocks = (body: string): ReadonlyArray<MigratedBlock> =>
  body
    .replace(/\r\n|\r/g, '\n')
    .split('\n\n')
    .filter((paragraph) => paragraph.trim() !== '')
    .map((text) => ({ type: 'paragraph', text }));

/** Bloques → texto con las variables sin sustituir (solo para down() de versiones creadas después de up()). */
export const blocksToLegacyBody = (blocks: ReadonlyArray<MigratedBlock>): string =>
  blocks
    .map((block) => {
      switch (block.type) {
        case 'heading':
        case 'paragraph':
        case 'callout':
          return block.text ?? '';
        case 'button':
          return `${block.label ?? ''}: ${block.url ?? ''}`;
        case 'keyValueList':
          return (block.items ?? []).map((item) => `${item.label}: ${item.value}`).join('\n');
        case 'divider':
          return '----------';
        default:
          return '';
      }
    })
    .filter((part) => part !== '')
    .join('\n\n');

export class EmailTemplateBlocks1767225800000 implements MigrationInterface {
  name = 'EmailTemplateBlocks1767225800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE email_template
        ADD COLUMN blocks JSONB NULL,
        ADD COLUMN activated_at TIMESTAMPTZ NULL,
        ADD COLUMN activated_by UUID NULL
    `);
    const rows = (await queryRunner.query(`SELECT id, body FROM email_template`)) as Array<{
      id: string;
      body: string;
    }>;
    for (const row of rows) {
      await queryRunner.query(`UPDATE email_template SET blocks = $2::jsonb WHERE id = $1`, [
        row.id,
        JSON.stringify(legacyBodyToBlocks(row.body)),
      ]);
    }
    await queryRunner.query(`ALTER TABLE email_template ALTER COLUMN blocks SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE email_template ALTER COLUMN body DROP NOT NULL`);
    await queryRunner.query(`
      UPDATE email_template t SET is_active = FALSE
      WHERE t.is_active
        AND EXISTS (
          SELECT 1 FROM email_template o
          WHERE o.template_type = t.template_type AND o.is_active AND o.version > t.version
        )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_email_template_active ON email_template (template_type) WHERE is_active
    `);

    await queryRunner.query(`
      ALTER TABLE mail_outbox
        ADD COLUMN template_version_id UUID NULL
          CONSTRAINT fk_mail_outbox_template_version REFERENCES email_template(id) ON DELETE SET NULL
    `);

    await queryRunner.query(`
      INSERT INTO permission
        (code, module, resource_type, resource_label, action, scope_level, description, is_system)
      VALUES
        ('email_template:read:global', 'SYSTEM', 'email_template', 'Plantillas de correo', 'read', 'GLOBAL',
         'Ver las plantillas de correo, sus versiones y la vista previa', TRUE),
        ('email_template:manage:global', 'SYSTEM', 'email_template', 'Plantillas de correo', 'manage', 'GLOBAL',
         'Diseñar y activar plantillas de correo y enviar correos de prueba', TRUE)
      ON CONFLICT (code) DO NOTHING
    `);
    await queryRunner.query(
      `
      INSERT INTO role_permission (role_id, permission_id)
      SELECT r.id, p.id
      FROM role r
      JOIN permission p ON p.code = ANY($1::text[])
      WHERE r.code = 'INTERNAL_CONTROL_DIRECTOR'
      ON CONFLICT DO NOTHING
    `,
      [PERMISSION_CODES],
    );

    await queryRunner.query(`
      INSERT INTO navigation_item
        (id, module, module_label, resource, path, label, required_action, sort_order, icon)
      VALUES
        ('${NAV_ID}', 'SYSTEM', 'Sistema', 'email_template', '/email-templates', 'Plantillas de correo', 'read', 106, 'mail')
      ON CONFLICT (path) DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM navigation_item WHERE id = '${NAV_ID}'`);
    await queryRunner.query(
      `DELETE FROM role_permission WHERE permission_id IN (SELECT id FROM permission WHERE code = ANY($1::text[]))`,
      [PERMISSION_CODES],
    );
    await queryRunner.query(`DELETE FROM permission WHERE code = ANY($1::text[])`, [PERMISSION_CODES]);

    await queryRunner.query(`
      ALTER TABLE mail_outbox DROP CONSTRAINT IF EXISTS fk_mail_outbox_template_version,
        DROP COLUMN IF EXISTS template_version_id
    `);

    await queryRunner.query(`DROP INDEX IF EXISTS uq_email_template_active`);
    const created = (await queryRunner.query(
      `SELECT id, blocks FROM email_template WHERE body IS NULL`,
    )) as Array<{ id: string; blocks: ReadonlyArray<MigratedBlock> }>;
    for (const row of created) {
      await queryRunner.query(`UPDATE email_template SET body = $2 WHERE id = $1`, [
        row.id,
        blocksToLegacyBody(row.blocks),
      ]);
    }
    await queryRunner.query(`ALTER TABLE email_template ALTER COLUMN body SET NOT NULL`);
    await queryRunner.query(`
      ALTER TABLE email_template
        DROP COLUMN blocks,
        DROP COLUMN activated_at,
        DROP COLUMN activated_by
    `);
  }
}
