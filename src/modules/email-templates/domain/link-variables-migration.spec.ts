import { describe, expect, it } from 'vitest';
import { legacyBodyToBlocks } from '../../../database/migrations/1767225800000-email-template-blocks.js';
import { upgradeBlocks } from '../../../database/migrations/1767225820000-email-rich-paragraph-and-assets.js';
import {
  LINK_VARIABLES,
  convertLinkVariables,
} from '../../../database/migrations/1767225840000-email-link-variables-as-links.js';
import { blockTexts, validateEmailBlocks, type EmailBlock } from './email-blocks.js';
import {
  EMAIL_TEMPLATE_TYPES,
  designPlaceholders,
  urlVariables,
  type EmailTemplateType,
} from './email-template-catalog.js';
import { textToRichText } from './rich-text.js';
import { urlVariablesAsText } from './url-variables-as-text.js';

// Textos sembrados por 1767225619000 / 1767225622000, como quedan tras 1767225800000 y 1767225820000.
const SEEDED: Partial<Record<EmailTemplateType, string>> = {
  USER_INVITATION:
    'Se creó su cuenta en {{app.name}}.\n\nRol: {{user.role}}\nCorreo: {{user.email}}\nUsuario: {{user.username}}\nContraseña temporal: {{auth.temporaryPassword}}\n\nInicie sesión en {{auth.loginUrl}} y cambie la contraseña.',
  PASSWORD_RESET:
    'Hola {{user.email}},\n\nUse este enlace para restablecer su contraseña:\n{{auth.resetUrl}}\n\nEl enlace vence en {{auth.expiresInHours}} horas.',
  GENERIC_NOTIFICATION: 'Hola {{user.email}},\n\n{{notification.message}}\n\n{{app.loginUrl}}',
  SYSTEM_ALERT: '{{alert.message}}',
  LOAN_STATUS_NOTIFICATION:
    'Hola {{user.email}},\nEl préstamo cambió a {{prestamo.estado}}.\nJustificación: {{prestamo.justificacion}}\n{{app.loginUrl}}',
  INVENTORY_ALERT: 'Hola {{user.email}},\n{{alerta.mensaje}}\n{{app.loginUrl}}',
};

const seeded = (type: EmailTemplateType): ReadonlyArray<EmailBlock> =>
  upgradeBlocks(legacyBodyToBlocks(SEEDED[type] ?? '')) as ReadonlyArray<EmailBlock>;

const link = (text: string, href: string) => ({ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] });

describe('migración 1767225840000: variables de enlace como texto → enlaces', () => {
  it('su copia de las variables de enlace coincide con el catálogo vivo', () => {
    for (const type of EMAIL_TEMPLATE_TYPES) {
      const live = Object.fromEntries([...urlVariables(type).values()].map((item) => [item.name, item.linkText]));
      expect(LINK_VARIABLES[type] ?? {}).toEqual(live);
    }
  });

  it('PASSWORD_RESET: el URL tras el salto pasa a ser el enlace "Restablecer contraseña"', () => {
    const before = seeded('PASSWORD_RESET');
    const after = convertLinkVariables('PASSWORD_RESET', before);
    expect(after).toEqual([
      before[0],
      {
        type: 'paragraph',
        content: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Use este enlace para restablecer su contraseña:' },
                { type: 'hardBreak' },
                link('Restablecer contraseña', '{{auth.resetUrl}}'),
              ],
            },
          ],
        },
      },
      before[2],
    ]);
  });

  it('USER_INVITATION: el URL en medio de la frase se reemplaza por el enlace, el resto del texto queda igual', () => {
    const after = convertLinkVariables('USER_INVITATION', seeded('USER_INVITATION')) ?? [];
    expect(after[2]).toEqual({
      type: 'paragraph',
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Inicie sesión en ' },
              link('Iniciar sesión', '{{auth.loginUrl}}'),
              { type: 'text', text: ' y cambie la contraseña.' },
            ],
          },
        ],
      },
    });
  });

  it.each(EMAIL_TEMPLATE_TYPES.filter((type) => SEEDED[type] !== undefined))(
    '%s sembrado: queda válido, sin URL como texto, con las mismas variables en el mismo orden',
    (type) => {
      const before = seeded(type);
      const after = convertLinkVariables(type, before);
      if (type === 'SYSTEM_ALERT') {
        expect(after).toBeNull();
        return;
      }
      expect(after).not.toBeNull();
      const blocks = (after ?? []) as ReadonlyArray<EmailBlock>;
      expect(urlVariablesAsText(type, before).length).toBeGreaterThan(0);
      expect(validateEmailBlocks(blocks)).toEqual([]);
      expect(urlVariablesAsText(type, blocks)).toEqual([]);
      expect(designPlaceholders({ subject: '', blocks })).toEqual(designPlaceholders({ subject: '', blocks: before }));
      // Idempotente: la versión convertida no genera otra.
      expect(convertLinkVariables(type, blocks)).toBeNull();
    },
  );

  it('no toca títulos, notas, listas de datos ni botones; dentro de una lista enriquecida sí convierte', () => {
    const blocks: EmailBlock[] = [
      { type: 'heading', text: '{{app.loginUrl}}' },
      { type: 'button', label: 'Ir', url: '{{app.loginUrl}}' },
      {
        type: 'paragraph',
        content: {
          type: 'doc',
          content: [
            { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Entre: {{app.loginUrl}}', marks: [{ type: 'bold' }] }] }] }] },
          ],
        },
      },
    ];
    const after = convertLinkVariables('INVENTORY_ALERT', blocks) ?? [];
    expect(after.slice(0, 2)).toEqual(blocks.slice(0, 2));
    expect(blockTexts(after[2] as EmailBlock)).toEqual(['Entre: ', 'Abrir Control Interno', '{{app.loginUrl}}']);
    expect(JSON.stringify(after[2])).toContain('"marks":[{"type":"bold"},{"type":"link","attrs":{"href":"{{app.loginUrl}}"}}]');
  });

  it('un tipo sin variables de enlace o un texto sin ellas no cambia', () => {
    expect(convertLinkVariables('SYSTEM_ALERT', [{ type: 'paragraph', content: textToRichText('{{alert.message}}') }] as never)).toBeNull();
    expect(convertLinkVariables('PASSWORD_RESET', [{ type: 'paragraph', content: textToRichText('Hola {{user.email}}') }] as never)).toBeNull();
    // Una variable de enlace de OTRO tipo no se convierte (es ajena; lo reporta la validación de variables).
    expect(convertLinkVariables('PASSWORD_RESET', [{ type: 'paragraph', content: textToRichText('{{firma.url}}') }] as never)).toBeNull();
  });
});
