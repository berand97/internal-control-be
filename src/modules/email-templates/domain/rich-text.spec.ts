import { describe, expect, it } from 'vitest';
import {
  RICH_TEXT_LIMITS,
  normalizeRichTextDoc,
  richTextTexts,
  richTextToText,
  textToRichText,
  validateRichTextDoc,
  type RichTextDoc,
} from './rich-text.js';

const fields = (doc: unknown): ReadonlyArray<string> => validateRichTextDoc(doc, 'c').map((issue) => issue.field);

const text = (value: string, marks?: ReadonlyArray<unknown>) => (marks ? { type: 'text', text: value, marks } : { type: 'text', text: value });
const p = (...content: ReadonlyArray<unknown>) => ({ type: 'paragraph', content });
const doc = (...content: ReadonlyArray<unknown>) => ({ type: 'doc', content });
const link = (href: string) => ({ type: 'link', attrs: { href } });

/** Lo que produce Tiptap (StarterKit + Underline + Link) para un párrafo con todo lo que admite el esquema. */
const FULL: RichTextDoc = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Hola ' },
        { type: 'text', text: '{{user.fullName}}', marks: [{ type: 'bold' }] },
        { type: 'hardBreak' },
        { type: 'text', text: 'cursiva', marks: [{ type: 'italic' }, { type: 'underline' }] },
        { type: 'text', text: ' y ' },
        { type: 'text', text: 'enlace', marks: [{ type: 'link', attrs: { href: '{{app.loginUrl}}' } }] },
      ],
    },
    { type: 'paragraph' },
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'uno' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'dos' }] }] },
      ],
    },
    {
      type: 'orderedList',
      content: [
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'portal', marks: [{ type: 'link', attrs: { href: 'https://www.unac.edu.co' } }] }],
            },
          ],
        },
      ],
    },
  ],
};

describe('validateRichTextDoc: esquema cerrado', () => {
  it('acepta todos los nodos y marcas del esquema', () => {
    expect(validateRichTextDoc(FULL, 'c')).toEqual([]);
  });

  it('rechaza lo que no es un doc, un doc vacío y propiedades extra del doc', () => {
    expect(fields('hola')).toEqual(['c']);
    expect(fields('<p>hola</p>')).toEqual(['c']);
    expect(fields({ type: 'paragraph', content: [] })).toEqual(['c']);
    expect(fields({ type: 'doc', content: [] })).toEqual(['c.content']);
    expect(fields({ type: 'doc' })).toEqual(['c.content']);
    expect(fields({ ...doc(p(text('x'))), attrs: {} })).toEqual(['c.attrs']);
  });

  it.each(['heading', 'blockquote', 'codeBlock', 'horizontalRule', 'image', 'table', 'html', 'taskList'])(
    'rechaza el nodo de bloque %s',
    (type) => {
      expect(fields(doc(p(text('x')), { type, content: [text('y')] }))).toEqual(['c.content[1].type']);
    },
  );

  it.each(['image', 'mention', 'emoji', 'paragraph', 'html'])('rechaza el nodo en línea %s', (type) => {
    expect(fields(doc(p(text('x'), { type, attrs: { src: 'https://x' } })))).toEqual(['c.content[0].content[1].type']);
  });

  it.each(['strike', 'code', 'highlight', 'textStyle', 'subscript', 'superscript', 'color'])('rechaza la marca %s', (type) => {
    expect(fields(doc(p(text('x', [{ type }]))))).toEqual(['c.content[0].content[0].marks[0].type']);
  });

  it('rechaza atributos que Tiptap agrega por defecto (el frontend debe quitarlos)', () => {
    expect(
      fields(doc(p(text('x', [{ type: 'link', attrs: { href: 'https://a.co', target: '_blank', rel: 'noopener', class: null } }])))),
    ).toEqual([
      'c.content[0].content[0].marks[0].attrs.target',
      'c.content[0].content[0].marks[0].attrs.rel',
      'c.content[0].content[0].marks[0].attrs.class',
    ]);
    expect(fields(doc({ type: 'paragraph', attrs: { textAlign: null }, content: [text('x')] }))).toEqual(['c.content[0].attrs']);
    expect(
      fields(doc({ type: 'orderedList', attrs: { start: 1, type: null }, content: [{ type: 'listItem', content: [p(text('x'))] }] })),
    ).toEqual(['c.content[0].attrs']);
    expect(fields(doc(p(text('x', [{ type: 'bold', attrs: {} }]))))).toEqual(['c.content[0].content[0].marks[0].attrs']);
    expect(fields(doc(p({ type: 'text', text: 'x', style: 'color:red' })))).toEqual(['c.content[0].content[0].style']);
  });

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<b>x</b>',
    'http://inseguro.example',
    'mailto:alguien@unac.edu.co',
    '{{app.loginUrl}}/extra',
    'https://ok.example/{{user.email}}',
    'https://con espacio.example',
    '',
  ])('rechaza el href %j', (href) => {
    expect(fields(doc(p(text('x', [link(href)]))))).toEqual(['c.content[0].content[0].marks[0].attrs.href']);
  });

  it('link sin attrs, marca repetida y marcas que no son lista', () => {
    expect(fields(doc(p(text('x', [{ type: 'link' }]))))).toEqual(['c.content[0].content[0].marks[0].attrs']);
    expect(fields(doc(p(text('x', [{ type: 'bold' }, { type: 'bold' }]))))).toEqual(['c.content[0].content[0].marks[1].type']);
    expect(fields(doc(p({ type: 'text', text: 'x', marks: 'bold' })))).toEqual(['c.content[0].content[0].marks']);
  });

  it('listas: solo listItem > paragraph, sin anidar, no vacías', () => {
    const nested = {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [p(text('a')), { type: 'bulletList', content: [{ type: 'listItem', content: [p(text('b'))] }] }],
        },
      ],
    };
    expect(fields(doc(nested))).toEqual(['c.content[0].content[0].content[1].type']);
    expect(fields(doc({ type: 'bulletList', content: [p(text('a'))] }))).toEqual(['c.content[0].content[0].type']);
    expect(fields(doc({ type: 'bulletList', content: [] }))).toEqual(['c.content[0].content']);
    expect(fields(doc({ type: 'orderedList', content: [{ type: 'listItem', content: [] }] }))).toEqual([
      'c.content[0].content[0].content',
    ]);
    expect(fields(doc({ type: 'bulletList', content: [{ type: 'listItem', content: [text('suelto')] }] }))).toEqual([
      'c.content[0].content[0].content[0].type',
    ]);
  });

  it('texto vacío, no texto, variable partida por un formato y documento sin texto visible', () => {
    expect(fields(doc(p({ type: 'text', text: '' })))).toEqual(['c.content[0].content[0].text']);
    expect(fields(doc(p({ type: 'text', text: 42 })))).toEqual(['c.content[0].content[0].text']);
    expect(fields(doc(p(text('Hola {{user.'), text('email}}', [{ type: 'bold' }]))))).toEqual([
      'c.content[0].content[0].text',
      'c.content[0].content[1].text',
    ]);
    expect(fields(doc(p(text('   ')), { type: 'paragraph' }))).toEqual(['c']);
    expect(fields(doc(p(text('{{ user.email }}'))))).toEqual([]);
  });

  it('límites: texto total y número de nodos', () => {
    const half = 'x'.repeat(RICH_TEXT_LIMITS.maxTextLength / 2);
    expect(fields(doc(p(text(half)), p(text(half))))).toEqual([]);
    expect(fields(doc(p(text(half)), p(text(`${half}y`))))).toEqual(['c']);
    // Cada párrafo con un texto son 2 nodos.
    const many = Array.from({ length: RICH_TEXT_LIMITS.maxNodes / 2 + 1 }, () => p(text('a')));
    expect(fields(doc(...many))).toEqual(['c']);
    expect(fields(doc(...many.slice(1)))).toEqual([]);
  });
});

describe('normalizeRichTextDoc y richTextTexts', () => {
  it('quita marcas vacías y marcas de un salto; recorta el href', () => {
    const input = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'a', marks: [] },
            { type: 'hardBreak', marks: [{ type: 'bold' }] },
            { type: 'text', text: 'b', marks: [{ type: 'link', attrs: { href: ' {{app.loginUrl}} ' } }] },
          ],
        },
        { type: 'paragraph', content: [] },
      ],
    } as unknown as RichTextDoc;
    expect(normalizeRichTextDoc(input)).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'a' },
            { type: 'hardBreak' },
            { type: 'text', text: 'b', marks: [{ type: 'link', attrs: { href: '{{app.loginUrl}}' } }] },
          ],
        },
        { type: 'paragraph' },
      ],
    });
  });

  it('textos con variables: cada nodo text y cada href, también dentro de listas', () => {
    expect(richTextTexts(FULL)).toEqual([
      'Hola ',
      '{{user.fullName}}',
      'cursiva',
      ' y ',
      'enlace',
      '{{app.loginUrl}}',
      'uno',
      'dos',
      'portal',
      'https://www.unac.edu.co',
    ]);
  });
});

describe('conversión texto ↔ documento (migración 1767225820000)', () => {
  it.each([
    'Hola {{user.email}},',
    'A\nB\n\nC',
    'A\n\n\nB',
    'A\n\n\n\nB',
    '\nA',
    'A\n',
    'A\n\n',
    'Insertados: 8780\nOmitidos por ya existir: 0\nEn cuarentena: 161',
    '  sangría  \n\tTab',
  ])('ida y vuelta sin pérdida: %j', (value) => {
    expect(richTextToText(textToRichText(value))).toBe(value);
  });

  it('línea en blanco = párrafo nuevo; salto simple = hardBreak', () => {
    expect(textToRichText('A\nB\n\nC')).toEqual({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'A' }, { type: 'hardBreak' }, { type: 'text', text: 'B' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'C' }] },
      ],
    });
    expect(textToRichText('A\r\n\r\nB').content).toHaveLength(2);
  });

  it('el texto convertido pasa la validación', () => {
    expect(validateRichTextDoc(textToRichText('Hola {{user.email}},\nLínea 2\n\nOtro párrafo'), 'c')).toEqual([]);
  });

  it('documento → texto pierde las marcas; listas como "- " y "1. "; enlaces como "texto (href)"', () => {
    expect(richTextToText(FULL)).toBe(
      'Hola {{user.fullName}}\ncursiva y enlace ({{app.loginUrl}})\n\n\n\n- uno\n- dos\n\n1. portal (https://www.unac.edu.co)',
    );
  });
});
