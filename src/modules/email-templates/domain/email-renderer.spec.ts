import { describe, expect, it } from 'vitest';
import type { EmailBlock } from './email-blocks.js';
import { textToRichText, type RichTextDoc } from './rich-text.js';
import {
  escapeHtml,
  renderEmail,
  renderEmailHtml,
  renderEmailPlainText,
  renderSubject,
  resolveButtonUrl,
  richTextHtml,
  richTextPlain,
  type EmailAssetLookup,
} from './email-renderer.js';
import { DEFAULT_EMAIL_DESIGNS, EMAIL_SAMPLE_CONTEXT } from './email-template-catalog.js';

const MALICIOUS = `Ana <b>"Mala"</b> & <script>alert('x')</script><img src=x onerror=alert(1)>`;

const RICH: RichTextDoc = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Hola ' },
        { type: 'text', text: '{{n}}', marks: [{ type: 'bold' }, { type: 'italic' }, { type: 'underline' }] },
        { type: 'hardBreak' },
        { type: 'text', text: 'entre ', marks: [{ type: 'italic' }] },
        { type: 'text', text: 'aquí', marks: [{ type: 'link', attrs: { href: '{{u}}' } }, { type: 'bold' }] },
      ],
    },
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'uno' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'dos {{n}}' }] }] },
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
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'segundo' }] }] },
      ],
    },
    { type: 'paragraph' },
  ],
};

describe('párrafo enriquecido', () => {
  it('marcas como <strong>, <em>, <u> y <a> con estilo en línea; listas <ul>/<ol>; párrafo vacío = &nbsp;', () => {
    const html = richTextHtml(RICH, { n: 'Ana', u: 'https://control.unac.edu.co/x' });
    expect(html).toMatchSnapshot();
    expect(html).toContain('<strong><em><u>Ana</u></em></strong><br><em>entre </em>');
    expect(html).toContain(
      '<a href="https://control.unac.edu.co/x" target="_blank" rel="noopener" style="color:#306999;text-decoration:underline;"><strong>aquí</strong></a>',
    );
    expect(html).toMatch(/<ul style="margin:12px 0 0;padding:0 0 0 24px;[^"]*"><li style="margin:0 0 4px;">uno<\/li><li style="margin:0;">dos Ana<\/li><\/ul>/);
    expect(html).toContain('<ol style="margin:12px 0 0;padding:0 0 0 24px;');
    expect(html.endsWith('">&nbsp;</p>')).toBe(true);
  });

  it('una variable maliciosa dentro de marcas queda escapada', () => {
    const html = richTextHtml(RICH, { n: MALICIOUS, u: 'https://a.co' });
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<b>');
    expect(html).toContain('<strong><em><u>Ana &lt;b&gt;&quot;Mala&quot;&lt;/b&gt; &amp; &lt;script&gt;');
    const tags = html.match(/<[^>]+>/g) ?? [];
    expect(tags.some((tag) => /\son[a-z]+=/i.test(tag))).toBe(false);
  });

  it.each(['javascript:alert(1)', 'data:text/html,<b>x</b>', '/relativo', ''])(
    'un enlace cuya variable vale %j se degrada a texto',
    (value) => {
      const html = richTextHtml(RICH, { n: 'Ana', u: value });
      expect(html).toContain('<em>entre </em><strong>aquí</strong>');
      expect(html).not.toContain('javascript:');
      expect(html.match(/<a /g)).toHaveLength(1);
      expect(richTextPlain(RICH, { n: 'Ana', u: value })).toContain('entre aquí\n');
    },
  );

  it('texto plano: saltos, listas "- " y "1. ", enlaces "texto (url)"', () => {
    expect(richTextPlain(RICH, { n: 'Ana', u: 'https://control.unac.edu.co/x' })).toBe(
      'Hola Ana\nentre aquí (https://control.unac.edu.co/x)\n\n- uno\n- dos Ana\n\n1. portal (https://www.unac.edu.co)\n2. segundo',
    );
  });

  it('un párrafo simple se ve igual que el párrafo de texto de antes', () => {
    const html = renderEmailHtml('A', [{ type: 'paragraph', content: textToRichText('Uno\nDos') }], {});
    expect(html).toContain(
      '<p style="margin:0;font-family:Arial, \'Helvetica Neue\', Helvetica, sans-serif;font-size:15px;line-height:23px;color:#17283a;">Uno<br>Dos</p>',
    );
  });
});

describe('bloque imagen', () => {
  const ID = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
  const assets: EmailAssetLookup = new Map([
    [ID, { url: `https://api.unac.edu.co/api/v1/public/email-assets/${ID}`, width: 1200, height: 600 }],
  ]);

  it('src absoluto, alt escapado, ancho natural limitado a 560 con alto proporcional, centrado', () => {
    const html = renderEmailHtml('A', [{ type: 'image', assetId: ID, alt: 'Logo {{n}}', align: 'center' }], { n: MALICIOUS }, undefined, assets);
    expect(html).toContain(
      `<tr><td align="center" style="padding:0 32px 16px;"><img src="https://api.unac.edu.co/api/v1/public/email-assets/${ID}" alt="Logo Ana &lt;b&gt;&quot;Mala&quot;&lt;/b&gt; &amp; &lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;" width="560" height="280" border="0" style="display:block;width:560px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;margin:0 auto;"></td></tr>`,
    );
  });

  it('ancho pedido, alineada a la izquierda y con enlace; enlace inválido = imagen sin enlace', () => {
    const block: EmailBlock = { type: 'image', assetId: ID, alt: 'Portal', width: 200, align: 'left', href: '{{u}}' };
    const linked = renderEmailHtml('A', [block], { u: 'https://a.co/x' }, undefined, assets);
    expect(linked).toContain('<td align="left" style="padding:0 32px 16px;"><a href="https://a.co/x" target="_blank" rel="noopener" style="text-decoration:none;"><img ');
    expect(linked).toContain('width="200" height="100"');
    const unlinked = renderEmailHtml('A', [block], { u: 'javascript:alert(1)' }, undefined, assets);
    expect(unlinked).not.toContain('<a ');
    expect(unlinked).toContain('width="200" height="100"');
    expect(renderEmailPlainText([block], { u: 'https://a.co/x' }, undefined, assets)).toContain('[Imagen: Portal] (https://a.co/x)');
    expect(renderEmailPlainText([block], { u: 'javascript:x' }, undefined, assets)).toContain('[Imagen: Portal]\n\n--');
  });

  it('una imagen que no está en el lookup se omite del HTML y del texto', () => {
    const block: EmailBlock = { type: 'image', assetId: ID, alt: 'Portal', align: 'left' };
    expect(renderEmailHtml('A', [block], {})).not.toContain('<img');
    expect(renderEmailPlainText([block], {})).not.toContain('Imagen');
  });
});

describe('escapeHtml', () => {
  it('escapa los cinco caracteres con significado en HTML', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });
});

describe('renderEmailHtml: variables maliciosas', () => {
  const blocks: ReadonlyArray<EmailBlock> = [
    { type: 'heading', text: 'Hola {{user.fullName}}' },
    { type: 'paragraph', content: textToRichText('{{user.fullName}}') },
    { type: 'keyValueList', items: [{ label: '{{user.fullName}}', value: '{{user.fullName}}' }] },
    { type: 'callout', tone: 'info', text: '{{user.fullName}}' },
    { type: 'button', label: '{{user.fullName}}', url: '{{auth.loginUrl}}' },
  ];
  const html = renderEmailHtml('Asunto {{user.fullName}}', blocks, {
    'user.fullName': MALICIOUS,
    'auth.loginUrl': 'https://control.unac.edu.co/auth/login',
  });

  it('ningún valor inyecta marcado: no hay <b>, <script>, <img> ni atributos nuevos', () => {
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    const tags = html.match(/<[^>]+>/g) ?? [];
    expect(tags.some((tag) => /\son[a-z]+=/i.test(tag))).toBe(false);
    expect(html).toContain('Ana &lt;b&gt;&quot;Mala&quot;&lt;/b&gt; &amp; &lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;');
    // 6 apariciones: título, h1, párrafo, etiqueta y valor de la lista, nota; más la del botón.
    expect(html.split('&lt;script&gt;').length - 1).toBe(7);
  });

  it('el documento no trae script, CSS externo, formularios ni manejadores de eventos', () => {
    expect(html).not.toMatch(/<script|<link|<form|<input|<iframe|<style|@import/i);
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('max-width:600px');
  });
});

describe('resolveButtonUrl', () => {
  const ctx = (value: string) => ({ 'x.url': value });
  it.each([
    ['https://control.unac.edu.co/firmar/abc', 'https://control.unac.edu.co/firmar/abc'],
    ['http://localhost:4200/auth/login', 'http://localhost:4200/auth/login'],
  ])('acepta %s', (value, expected) => {
    expect(resolveButtonUrl('{{x.url}}', ctx(value))).toBe(expected);
  });

  it.each(['javascript:alert(1)', 'data:text/html,<b>x</b>', '/relativo', '', 'https://a b.co', 'vbscript:x'])(
    'rechaza %j (el botón se omite)',
    (value) => {
      expect(resolveButtonUrl('{{x.url}}', ctx(value))).toBeNull();
    },
  );

  it('un botón con URL rechazado no aparece ni en HTML ni en texto', () => {
    const blocks: ReadonlyArray<EmailBlock> = [
      { type: 'paragraph', content: textToRichText('Hola') },
      { type: 'button', label: 'Entrar', url: '{{x.url}}' },
    ];
    const context = ctx('javascript:alert(1)');
    expect(renderEmailHtml('A', blocks, context)).not.toContain('href=');
    expect(renderEmailPlainText(blocks, context)).not.toContain('Entrar');
  });

  it('un URL con comillas se escapa dentro del atributo', () => {
    const html = renderEmailHtml('A', [{ type: 'button', label: 'Ir', url: '{{x.url}}' }], ctx('https://a.co/?q="><script>'));
    expect(html).toContain('href="https://a.co/?q=%22%3E%3Cscript%3E"');
  });
});

describe('renderSubject', () => {
  it('sustituye y deja una sola línea', () => {
    expect(renderSubject('Hola {{n}}', { n: 'Ana\r\nBcc: x@evil.com' })).toBe('Hola Ana Bcc: x@evil.com');
  });
});

describe('renderEmailPlainText', () => {
  it('cada bloque tiene su forma en texto y el pie va al final', () => {
    const text = renderEmailPlainText(
      [
        { type: 'heading', text: 'Título {{n}}' },
        { type: 'paragraph', content: textToRichText('Uno\r\nDos') },
        { type: 'spacer', size: 'lg' },
        { type: 'button', label: 'Entrar', url: '{{u}}' },
        { type: 'divider' },
        { type: 'keyValueList', items: [{ label: 'Usuario', value: '{{n}}' }, { label: 'Rol', value: 'Consulta' }] },
        { type: 'callout', tone: 'warning', text: 'Ojo' },
      ],
      { n: '<Ana>', u: 'https://x.co/a' },
    );
    expect(text).toBe(
      [
        'Título <Ana>',
        'Uno\nDos',
        'Entrar: https://x.co/a',
        '----------------------------------------',
        'Usuario: <Ana>\nRol: Consulta',
        'Ojo',
        '-- \nMensaje automático enviado por Control Interno UNAC.',
      ].join('\n\n'),
    );
  });
});

describe('layout institucional', () => {
  const blocks: ReadonlyArray<EmailBlock> = [{ type: 'paragraph', content: textToRichText('x') }];

  it('sin logo muestra el nombre de la marca como texto', () => {
    const html = renderEmailHtml('A', blocks, {}, { name: 'Control Interno UNAC', logoUrl: null });
    expect(html).not.toContain('<img');
    expect(html).toContain('>Control Interno UNAC</span>');
  });

  it('con logo https usa la imagen; un logo que no es https se ignora', () => {
    const withLogo = renderEmailHtml('A', blocks, {}, { name: 'UNAC', logoUrl: 'https://cdn.unac.edu.co/logo.png' });
    expect(withLogo).toContain('<img src="https://cdn.unac.edu.co/logo.png" alt="UNAC"');
    const insecure = renderEmailHtml('A', blocks, {}, { name: 'UNAC', logoUrl: 'http://x/logo.png' });
    expect(insecure).not.toContain('<img');
  });
});

describe('snapshot estable', () => {
  it.each(['USER_INVITATION', 'SIGNATURE_LINK'] as const)('%s por defecto con datos de ejemplo', (type) => {
    const rendered = renderEmail(DEFAULT_EMAIL_DESIGNS[type], EMAIL_SAMPLE_CONTEXT[type]);
    expect(rendered).toMatchSnapshot();
  });
});
