import { describe, expect, it } from 'vitest';
import {
  blocksToLegacyBody,
  legacyBodyToBlocks,
} from '../../../database/migrations/1767225800000-email-template-blocks.js';
import {
  docToText,
  downgradeBlocks,
  textToDoc,
  upgradeBlocks,
} from '../../../database/migrations/1767225820000-email-rich-paragraph-and-assets.js';
import { validateEmailBlocks } from './email-blocks.js';
import { EMAIL_TEMPLATE_TYPES, extractEmailPlaceholders } from './email-template-catalog.js';
import { richTextToText, textToRichText, type RichTextDoc } from './rich-text.js';

const TYPES_AT_MIGRATION = [
  'USER_INVITATION',
  'PASSWORD_RESET',
  'GENERIC_NOTIFICATION',
  'SYSTEM_ALERT',
  'LOAN_STATUS_NOTIFICATION',
  'INVENTORY_ALERT',
  'SIGNATURE_LINK',
  'IMPORT_FINISHED',
] as const;

// Textos sembrados por 1767225619000 y 1767225622000 (los que existen en las BD desplegadas).
const LEGACY_BODIES: ReadonlyArray<string> = [
  'Se creó su cuenta en {{app.name}}.\n\nRol: {{user.role}}\nCorreo: {{user.email}}\nUsuario: {{user.username}}\nContraseña temporal: {{auth.temporaryPassword}}\n\nInicie sesión en {{auth.loginUrl}} y cambie la contraseña.',
  'Hola {{user.email}},\n\nUse este enlace para restablecer su contraseña:\n{{auth.resetUrl}}\n\nEl enlace vence en {{auth.expiresInHours}} horas.',
  'Hola {{user.email}},\n\n{{notification.message}}\n\n{{app.loginUrl}}',
  '{{alert.message}}',
  'Hola {{user.email}},\nEl préstamo cambió a {{prestamo.estado}}.\nJustificación: {{prestamo.justificacion}}\n{{app.loginUrl}}',
];

describe('migración 1767225800000: texto → bloques', () => {
  it.each(LEGACY_BODIES)('convierte sin perder nada (y 1767225820000 lo deja válido): %j', (body) => {
    const blocks = legacyBodyToBlocks(body);
    expect(blocks.every((block) => block.type === 'paragraph')).toBe(true);
    expect(blocks.map((block) => block.text).join('\n\n')).toBe(body);
    expect(extractEmailPlaceholders(blocks.map((block) => block.text).join('\n'))).toEqual(
      extractEmailPlaceholders(body),
    );
    expect(validateEmailBlocks(upgradeBlocks(blocks))).toEqual([]);
  });

  it('un párrafo por bloque, conservando los saltos de línea internos', () => {
    expect(legacyBodyToBlocks('A\nB\n\nC')).toEqual([
      { type: 'paragraph', text: 'A\nB' },
      { type: 'paragraph', text: 'C' },
    ]);
    expect(legacyBodyToBlocks('A\r\n\r\nB')).toEqual([
      { type: 'paragraph', text: 'A' },
      { type: 'paragraph', text: 'B' },
    ]);
  });

  it('down(): bloques → texto con las variables intactas', () => {
    expect(
      blocksToLegacyBody([
        { type: 'heading', text: 'T {{a}}' },
        { type: 'button', label: 'Ir', url: '{{b}}' },
        { type: 'keyValueList', items: [{ label: 'X', value: '{{c}}' }] },
        { type: 'spacer', size: 'sm' },
      ]),
    ).toBe('T {{a}}\n\nIr: {{b}}\n\nX: {{c}}');
    // Los 8 tipos que existían cuando corrió esta migración siguen en el catálogo (los posteriores nunca tuvieron texto).
    expect(EMAIL_TEMPLATE_TYPES).toEqual(expect.arrayContaining([...TYPES_AT_MIGRATION]));
  });
});

describe('migración 1767225820000: párrafo de texto → documento enriquecido', () => {
  const SAMPLES = [...LEGACY_BODIES, 'A\n\n\nB', 'A\n\n\n\nB', '\nA', 'A\n', 'Insertados: 8780\nOmitidos: 0'];

  it.each(SAMPLES)('ida y vuelta sin pérdida, igual que la conversión viva: %j', (text) => {
    expect(docToText(textToDoc(text))).toBe(text);
    expect(textToDoc(text)).toEqual(textToRichText(text));
  });

  it('up() cambia solo los párrafos de texto; es idempotente; down() los devuelve', () => {
    const before = [
      { type: 'heading', text: 'T {{a}}' },
      { type: 'paragraph', text: 'Hola {{user.email}},\nLínea 2\n\nOtro' },
      { type: 'button', label: 'Ir', url: '{{b}}' },
    ];
    const upgraded = upgradeBlocks(before);
    expect(upgraded).toEqual([
      before[0],
      { type: 'paragraph', content: textToRichText('Hola {{user.email}},\nLínea 2\n\nOtro') },
      before[2],
    ]);
    expect(upgradeBlocks(upgraded)).toEqual(upgraded);
    expect(downgradeBlocks(upgraded)).toEqual(before);
    expect(downgradeBlocks(before)).toEqual(before);
  });

  it('down() pierde marcas y listas (documentado) e imagen → "[Imagen: alt]"', () => {
    const rich: RichTextDoc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Hola ', marks: [{ type: 'bold' }] },
            { type: 'text', text: 'aquí', marks: [{ type: 'link', attrs: { href: '{{app.loginUrl}}' } }] },
          ],
        },
        {
          type: 'orderedList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'uno' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'dos' }] }] },
          ],
        },
      ],
    };
    const stored = [
      { type: 'paragraph', content: rich },
      { type: 'image', assetId: '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b', alt: 'Logo {{app.name}}', align: 'left' },
    ];
    expect(downgradeBlocks(stored)).toEqual([
      { type: 'paragraph', text: 'Hola aquí ({{app.loginUrl}})\n\n1. uno\n2. dos' },
      { type: 'paragraph', text: '[Imagen: Logo {{app.name}}]' },
    ]);
    expect(docToText(rich)).toBe(richTextToText(rich));
  });
});
