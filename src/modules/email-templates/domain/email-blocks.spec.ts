import { describe, expect, it } from 'vitest';
import { EMAIL_DESIGN_LIMITS, normalizeEmailBlocks, validateEmailBlocks, type EmailBlock } from './email-blocks.js';

const fields = (blocks: unknown): ReadonlyArray<string> => validateEmailBlocks(blocks).map((issue) => issue.field);

describe('validateEmailBlocks', () => {
  it('acepta cada bloque del catálogo', () => {
    const blocks: ReadonlyArray<EmailBlock> = [
      { type: 'heading', text: 'Hola {{user.fullName}}' },
      { type: 'paragraph', text: 'Línea 1\nLínea 2' },
      { type: 'button', label: 'Entrar', url: '{{auth.loginUrl}}' },
      { type: 'button', label: 'Portal', url: 'https://www.unac.edu.co/portal?x=1' },
      { type: 'divider' },
      { type: 'keyValueList', items: [{ label: 'Usuario', value: '{{user.username}}' }] },
      { type: 'callout', tone: 'warning', text: 'Cuidado' },
      { type: 'spacer', size: 'md' },
    ];
    expect(validateEmailBlocks(blocks)).toEqual([]);
  });

  it('rechaza lo que no es una lista, lista vacía y más del máximo de bloques', () => {
    expect(fields('hola')).toEqual(['blocks']);
    expect(fields([])).toEqual(['blocks']);
    const many = Array.from({ length: EMAIL_DESIGN_LIMITS.maxBlocks + 1 }, () => ({ type: 'divider' }));
    expect(fields(many)).toEqual(['blocks']);
  });

  it('rechaza tipos fuera del catálogo (html, image, script) y campos de más', () => {
    expect(fields([{ type: 'html', html: '<b>x</b>' }])).toEqual(['blocks[0].type']);
    expect(fields([{ type: 'image', src: 'https://x' }])).toEqual(['blocks[0].type']);
    expect(fields([{ type: 'paragraph', text: 'x', style: 'color:red' }])).toEqual(['blocks[0].style']);
    expect(fields([{ type: 'divider', text: 'x' }])).toEqual(['blocks[0].text']);
    expect(fields([null])).toEqual(['blocks[0].type']);
  });

  it('exige textos no vacíos y dentro del largo máximo', () => {
    expect(fields([{ type: 'paragraph', text: '   ' }])).toEqual(['blocks[0].text']);
    expect(fields([{ type: 'paragraph' }])).toEqual(['blocks[0].text']);
    expect(fields([{ type: 'heading', text: 'x'.repeat(EMAIL_DESIGN_LIMITS.headingMaxLength + 1) }])).toEqual([
      'blocks[0].text',
    ]);
    expect(fields([{ type: 'paragraph', text: 42 }])).toEqual(['blocks[0].text']);
  });

  it.each([
    'javascript:alert(1)',
    'http://inseguro.example',
    'https://ok.example/{{user.email}}',
    '{{auth.loginUrl}}/extra',
    'https://con espacio.example',
    'data:text/html,hola',
    'mailto:alguien@unac.edu.co',
  ])('rechaza el URL de botón %j', (url) => {
    expect(fields([{ type: 'button', label: 'Ir', url }])).toEqual(['blocks[0].url']);
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

  it('normalizeEmailBlocks deja solo los campos del catálogo y recorta el URL', () => {
    expect(normalizeEmailBlocks([{ type: 'button', label: 'Ir', url: ' {{auth.loginUrl}} ' }])).toEqual([
      { type: 'button', label: 'Ir', url: '{{auth.loginUrl}}' },
    ]);
  });
});
