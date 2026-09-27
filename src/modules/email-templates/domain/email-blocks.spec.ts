import { describe, expect, it } from 'vitest';
import {
  EMAIL_BLOCK_CATALOG,
  EMAIL_BLOCK_TYPES,
  EMAIL_DESIGN_LIMITS,
  blockTexts,
  imageAssetIds,
  normalizeEmailBlocks,
  validateEmailBlocks,
  type EmailBlock,
} from './email-blocks.js';
import { textToRichText } from './rich-text.js';

const fields = (blocks: unknown): ReadonlyArray<string> => validateEmailBlocks(blocks).map((issue) => issue.field);

const ASSET = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
const image = (extra: Record<string, unknown> = {}) => ({ type: 'image', assetId: ASSET, alt: 'Logo', align: 'center', ...extra });

describe('validateEmailBlocks', () => {
  it('acepta cada bloque del catálogo', () => {
    const blocks: ReadonlyArray<EmailBlock> = [
      { type: 'heading', text: 'Hola {{user.fullName}}' },
      { type: 'paragraph', content: textToRichText('Línea 1\nLínea 2') },
      { type: 'button', label: 'Entrar', url: '{{auth.loginUrl}}' },
      { type: 'button', label: 'Portal', url: 'https://www.unac.edu.co/portal?x=1' },
      { type: 'divider' },
      { type: 'keyValueList', items: [{ label: 'Usuario', value: '{{user.username}}' }] },
      { type: 'callout', tone: 'warning', text: 'Cuidado' },
      { type: 'spacer', size: 'md' },
      { type: 'image', assetId: ASSET, alt: 'Logo de {{app.name}}', align: 'left' },
      { type: 'image', assetId: ASSET, alt: 'Portal', width: 300, align: 'center', href: '{{app.loginUrl}}' },
    ];
    expect(validateEmailBlocks(blocks)).toEqual([]);
  });

  it('rechaza lo que no es una lista, lista vacía y más del máximo de bloques', () => {
    expect(fields('hola')).toEqual(['blocks']);
    expect(fields([])).toEqual(['blocks']);
    const many = Array.from({ length: EMAIL_DESIGN_LIMITS.maxBlocks + 1 }, () => ({ type: 'divider' }));
    expect(fields(many)).toEqual(['blocks']);
  });

  it('rechaza tipos fuera del catálogo (html, script) y campos de más', () => {
    expect(fields([{ type: 'html', html: '<b>x</b>' }])).toEqual(['blocks[0].type']);
    expect(fields([{ type: 'script', text: 'x' }])).toEqual(['blocks[0].type']);
    expect(fields([{ type: 'paragraph', content: textToRichText('x'), style: 'color:red' }])).toEqual(['blocks[0].style']);
    expect(fields([{ type: 'divider', text: 'x' }])).toEqual(['blocks[0].text']);
    expect(fields([null])).toEqual(['blocks[0].type']);
  });

  it('párrafo: exige content (documento); el texto plano de antes ya no se acepta', () => {
    expect(fields([{ type: 'paragraph', text: 'x' }])).toEqual(['blocks[0].text', 'blocks[0].content']);
    expect(fields([{ type: 'paragraph' }])).toEqual(['blocks[0].content']);
    expect(fields([{ type: 'paragraph', content: '<p>x</p>' }])).toEqual(['blocks[0].content']);
    expect(fields([{ type: 'paragraph', content: textToRichText('   ') }])).toEqual(['blocks[0].content']);
    const withLink = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }],
        },
      ],
    };
    expect(fields([{ type: 'paragraph', content: withLink }])).toEqual([
      'blocks[0].content.content[0].content[0].marks[0].attrs.href',
    ]);
  });

  it('exige textos no vacíos y dentro del largo máximo', () => {
    expect(fields([{ type: 'heading', text: '   ' }])).toEqual(['blocks[0].text']);
    expect(fields([{ type: 'heading', text: 'x'.repeat(EMAIL_DESIGN_LIMITS.headingMaxLength + 1) }])).toEqual([
      'blocks[0].text',
    ]);
    expect(fields([{ type: 'callout', tone: 'info', text: 42 }])).toEqual(['blocks[0].text']);
  });

  it.each([
    'javascript:alert(1)',
    'http://inseguro.example',
    'https://ok.example/{{user.email}}',
    '{{auth.loginUrl}}/extra',
    'https://con espacio.example',
    'data:text/html,hola',
    'mailto:alguien@unac.edu.co',
  ])('rechaza el URL de botón y de imagen %j', (url) => {
    expect(fields([{ type: 'button', label: 'Ir', url }])).toEqual(['blocks[0].url']);
    expect(fields([image({ href: url })])).toEqual(['blocks[0].href']);
  });

  it('valida tono, tamaño y filas de la lista', () => {
    expect(fields([{ type: 'callout', tone: 'danger', text: 'x' }])).toEqual(['blocks[0].tone']);
    expect(fields([{ type: 'spacer', size: 'xl' }])).toEqual(['blocks[0].size']);
    expect(fields([{ type: 'keyValueList', items: [] }])).toEqual(['blocks[0].items']);
    expect(fields([{ type: 'keyValueList', items: [{ label: 'a', value: 'b', extra: 1 }] }])).toEqual([
      'blocks[0].items[0].extra',
    ]);
    expect(fields([{ type: 'keyValueList', items: [{ label: '', value: 'b' }] }])).toEqual([
      'blocks[0].items[0].label',
    ]);
    const tooMany = Array.from({ length: EMAIL_DESIGN_LIMITS.keyValueMaxItems + 1 }, () => ({ label: 'a', value: 'b' }));
    expect(fields([{ type: 'keyValueList', items: tooMany }])).toEqual(['blocks[0].items']);
  });

  it('imagen: id uuid, alt obligatorio, ancho entero en rango, alineación, sin src ni campos extra', () => {
    expect(fields([image({ assetId: 'logo.png' })])).toEqual(['blocks[0].assetId']);
    expect(fields([image({ alt: '' })])).toEqual(['blocks[0].alt']);
    expect(fields([image({ alt: 'x'.repeat(EMAIL_DESIGN_LIMITS.imageAltMaxLength + 1) })])).toEqual(['blocks[0].alt']);
    expect(fields([{ type: 'image', assetId: ASSET, align: 'left' }])).toEqual(['blocks[0].alt']);
    expect(fields([image({ width: EMAIL_DESIGN_LIMITS.imageMinWidth - 1 })])).toEqual(['blocks[0].width']);
    expect(fields([image({ width: EMAIL_DESIGN_LIMITS.imageMaxWidth + 1 })])).toEqual(['blocks[0].width']);
    expect(fields([image({ width: 120.5 })])).toEqual(['blocks[0].width']);
    expect(fields([image({ width: '300' })])).toEqual(['blocks[0].width']);
    expect(fields([image({ width: null })])).toEqual(['blocks[0].width']);
    expect(fields([image({ align: 'right' })])).toEqual(['blocks[0].align']);
    expect(fields([image({ src: 'https://evil.example/x.png' })])).toEqual(['blocks[0].src']);
    expect(fields([image({ width: EMAIL_DESIGN_LIMITS.imageMaxWidth })])).toEqual([]);
  });

  it(`máximo ${EMAIL_DESIGN_LIMITS.maxImages} imágenes por correo`, () => {
    const images = Array.from({ length: EMAIL_DESIGN_LIMITS.maxImages }, () => image());
    expect(fields(images)).toEqual([]);
    expect(fields([...images, image()])).toEqual(['blocks']);
  });

  it('normalizeEmailBlocks deja solo los campos del catálogo y recorta los URL', () => {
    expect(normalizeEmailBlocks([{ type: 'button', label: 'Ir', url: ' {{auth.loginUrl}} ' }])).toEqual([
      { type: 'button', label: 'Ir', url: '{{auth.loginUrl}}' },
    ]);
    expect(
      normalizeEmailBlocks([{ type: 'image', assetId: ASSET.toUpperCase(), alt: 'A', align: 'left', href: ' https://a.co ' }]),
    ).toEqual([{ type: 'image', assetId: ASSET, alt: 'A', align: 'left', href: 'https://a.co' }]);
  });

  it('blockTexts e imageAssetIds', () => {
    expect(blockTexts({ type: 'image', assetId: ASSET, alt: '{{a}}', align: 'left', href: '{{b}}' })).toEqual([
      '{{a}}',
      '{{b}}',
    ]);
    expect(blockTexts({ type: 'paragraph', content: textToRichText('{{a}}\n{{b}}') })).toEqual(['{{a}}', '{{b}}']);
    expect(
      imageAssetIds([
        { type: 'image', assetId: ASSET, alt: 'a', align: 'left' },
        { type: 'image', assetId: ASSET.toUpperCase(), alt: 'b', align: 'left' },
        { type: 'divider' },
      ]),
    ).toEqual([ASSET]);
  });

  it('el catálogo describe cada tipo de bloque; párrafo richText e imagen con sus controles', () => {
    expect(EMAIL_BLOCK_CATALOG.map((spec) => spec.type)).toEqual([...EMAIL_BLOCK_TYPES]);
    expect(EMAIL_BLOCK_CATALOG.find((spec) => spec.type === 'paragraph')?.fields).toEqual([
      expect.objectContaining({ name: 'content', kind: 'richText', maxLength: EMAIL_DESIGN_LIMITS.paragraphMaxLength }),
    ]);
    expect(
      EMAIL_BLOCK_CATALOG.find((spec) => spec.type === 'image')?.fields.map((item) => [item.name, item.kind, item.required]),
    ).toEqual([
      ['assetId', 'image', true],
      ['alt', 'text', true],
      ['width', 'integer', false],
      ['align', 'enum', true],
      ['href', 'url', false],
    ]);
  });
});
