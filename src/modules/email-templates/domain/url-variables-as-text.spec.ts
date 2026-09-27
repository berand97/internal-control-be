import { describe, expect, it } from 'vitest';
import { validateEmailBlocks, type EmailBlock } from './email-blocks.js';
import { DEFAULT_EMAIL_DESIGNS, EMAIL_TEMPLATE_TYPES } from './email-template-catalog.js';
import { textToRichText, type RichTextDoc } from './rich-text.js';
import { urlVariablesAsText } from './url-variables-as-text.js';

const MESSAGE = 'Use la variable {{auth.resetUrl}} como enlace o botón, no como texto';

const linked = (text: string, href: string): RichTextDoc => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] }] }],
});

describe('urlVariablesAsText', () => {
  it('párrafo: URL como texto tras un salto, con la ruta exacta del nodo', () => {
    const blocks: EmailBlock[] = [
      { type: 'paragraph', content: textToRichText('Hola {{user.email}},') },
      { type: 'paragraph', content: textToRichText('Use este enlace:\n{{auth.resetUrl}}') },
    ];
    expect(validateEmailBlocks(blocks)).toEqual([]);
    expect(urlVariablesAsText('PASSWORD_RESET', blocks)).toEqual([
      { field: 'blocks[1].content.content[0].content[2].text', message: MESSAGE },
    ]);
  });

  it('párrafo: el texto visible de un enlace tampoco puede ser el URL', () => {
    expect(urlVariablesAsText('PASSWORD_RESET', [{ type: 'paragraph', content: linked('{{auth.resetUrl}}', '{{auth.resetUrl}}') }])).toEqual([
      { field: 'blocks[0].content.content[0].content[0].text', message: MESSAGE },
    ]);
  });

  it('párrafo: dentro de una lista, con la ruta del ítem', () => {
    const content: RichTextDoc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Pasos' }] },
        {
          type: 'orderedList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Entre' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Vaya a {{auth.loginUrl}}' }] }] },
          ],
        },
      ],
    };
    expect(urlVariablesAsText('USER_INVITATION', [{ type: 'paragraph', content }])).toEqual([
      {
        field: 'blocks[0].content.content[1].content[1].content[0].content[0].text',
        message: 'Use la variable {{auth.loginUrl}} como enlace o botón, no como texto',
      },
    ]);
  });

  it.each([
    ['heading', { type: 'heading', text: 'Entre en {{app.loginUrl}}' }, 'blocks[0].text'],
    ['callout', { type: 'callout', tone: 'info', text: 'Enlace: {{app.loginUrl}}' }, 'blocks[0].text'],
    [
      'keyValueList',
      { type: 'keyValueList', items: [{ label: 'Estado', value: '{{prestamo.estado}}' }, { label: 'Enlace', value: '{{app.loginUrl}}' }] },
      'blocks[0].items[1].value',
    ],
  ] as const)('%s: URL como texto se rechaza en %s', (_name, block, field) => {
    expect(urlVariablesAsText('LOAN_STATUS_NOTIFICATION', [block as EmailBlock])).toEqual([
      { field, message: 'Use la variable {{app.loginUrl}} como enlace o botón, no como texto' },
    ]);
  });

  it('como href de un enlace, URL de un botón o enlace de una imagen sí se permite', () => {
    const blocks: EmailBlock[] = [
      { type: 'paragraph', content: linked('Restablecer contraseña', '{{auth.resetUrl}}') },
      { type: 'button', label: 'Restablecer', url: '{{auth.resetUrl}}' },
      { type: 'image', assetId: '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b', alt: 'Logo', align: 'left', href: '{{auth.resetUrl}}' },
    ];
    expect(urlVariablesAsText('PASSWORD_RESET', blocks)).toEqual([]);
  });

  it('las variables de texto sí van como texto; la regla depende del tipo', () => {
    expect(urlVariablesAsText('PASSWORD_RESET', [{ type: 'heading', text: '{{user.email}} {{app.name}}' }])).toEqual([]);
    // firma.url no es de PASSWORD_RESET: eso lo reporta la regla de variables ajenas, no esta.
    expect(urlVariablesAsText('PASSWORD_RESET', [{ type: 'heading', text: '{{firma.url}}' }])).toEqual([]);
    expect(urlVariablesAsText('SIGNATURE_LINK', [{ type: 'heading', text: '{{firma.url}}' }])).toHaveLength(1);
  });

  it.each(EMAIL_TEMPLATE_TYPES)('el diseño por defecto de %s no muestra ningún URL como texto', (type) => {
    expect(urlVariablesAsText(type, DEFAULT_EMAIL_DESIGNS[type].blocks)).toEqual([]);
  });
});
