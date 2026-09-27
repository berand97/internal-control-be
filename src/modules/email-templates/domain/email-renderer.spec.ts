import { describe, expect, it } from 'vitest';
import type { EmailBlock } from './email-blocks.js';
import {
  escapeHtml,
  renderEmail,
  renderEmailHtml,
  renderEmailPlainText,
  renderSubject,
  resolveButtonUrl,
} from './email-renderer.js';
import { DEFAULT_EMAIL_DESIGNS, EMAIL_SAMPLE_CONTEXT } from './email-template-catalog.js';

const MALICIOUS = `Ana <b>"Mala"</b> & <script>alert('x')</script><img src=x onerror=alert(1)>`;

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
    { type: 'paragraph', text: '{{user.fullName}}' },
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
      { type: 'paragraph', text: 'Hola' },
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
        { type: 'paragraph', text: 'Uno\r\nDos' },
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
  const blocks: ReadonlyArray<EmailBlock> = [{ type: 'paragraph', text: 'x' }];

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
