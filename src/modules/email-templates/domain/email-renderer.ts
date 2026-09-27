import { EMAIL_DESIGN_LIMITS, buttonUrlToken, isHttpsLiteral, type EmailBlock, type ImageBlock } from './email-blocks.js';
import {
  DEFAULT_EMAIL_BRAND,
  EMAIL_COLORS as C,
  EMAIL_CONTENT_WIDTH,
  EMAIL_FONT_STACK,
  EMAIL_FOOTER_TEXT,
  type EmailBrand,
} from './email-layout.js';
import type { RichTextDoc, RichTextInline, RichTextParagraph } from './rich-text.js';

/**
 * Renderizador propio bloques → HTML para correo (tablas y estilos en línea, 600 px, sin <script>, sin CSS externo,
 * sin formularios) y su versión en texto plano.
 *
 * Seguridad: TODO texto, literal o de una variable, se escapa; el único marcado es el que escribe este archivo. Los
 * URL de botón, de los enlaces del párrafo y de las imágenes que vienen de una variable se aceptan solo si son
 * http(s) absolutos; si no, el botón se omite y el enlace o la imagen quedan sin enlace. El `src` de una imagen lo
 * arma el servicio (URL pública del backend + id del asset), nunca el diseño.
 */

const TOKEN_PATTERN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

export type EmailContext = Readonly<Record<string, string>>;

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/** Imagen subida lista para el correo: URL pública absoluta y tamaño natural en px. */
export interface EmailImageAsset {
  readonly url: string;
  readonly width: number;
  readonly height: number;
}

/** Imágenes del diseño por id (minúsculas). Una imagen que no está se omite del correo. */
export type EmailAssetLookup = ReadonlyMap<string, EmailImageAsset>;

const NO_ASSETS: EmailAssetLookup = new Map();

export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Sustituye variables; lo que no está en el contexto queda vacío. Resultado en texto plano (sin escapar). */
export const substitute = (template: string, context: EmailContext): string =>
  template.replace(TOKEN_PATTERN, (_full, token: string) => context[token] ?? '');

const normalizeNewlines = (value: string): string => value.replace(/\r\n|\r/g, '\n');

/** Texto con variables → HTML escapado, con los saltos de línea como <br>. */
const htmlText = (template: string, context: EmailContext): string =>
  escapeHtml(normalizeNewlines(substitute(template, context))).replace(/\n/g, '<br>');

// Saltos de línea, incluidos U+2028 y U+2029 (construidos con fromCharCode: el literal rompe el analizador).
const LINE_BREAKS = new RegExp(`[\\r\\n${String.fromCharCode(0x2028, 0x2029)}]+`, 'g');

/** Una sola línea: los saltos de línea de una variable se vuelven espacios. */
const singleLine = (value: string): string => value.replace(LINE_BREAKS, ' ').replace(/\s{2,}/g, ' ').trim();

/** El asunto es una sola línea: los saltos de línea de una variable se vuelven espacios. */
export const renderSubject = (subject: string, context: EmailContext): string =>
  singleLine(substitute(subject, context));

/** URL final de un botón (o de un enlace o imagen), o null si no es un http(s) absoluto seguro. */
export const resolveButtonUrl = (url: string, context: EmailContext): string | null => {
  const token = buttonUrlToken(url);
  if (token === null) {
    return isHttpsLiteral(url.trim()) ? url.trim() : null;
  }
  const value = (context[token] ?? '').trim();
  if (value === '' || /\s/.test(value)) {
    return null;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
};

const SPACER_PX = { sm: 8, md: 16, lg: 32 } as const;

const row = (inner: string, padding = '0 32px 16px'): string =>
  `<tr><td style="padding:${padding};">${inner}</td></tr>`;

// ---------- Texto enriquecido (párrafo) ----------

const TEXT_STYLE = `font-family:${EMAIL_FONT_STACK};font-size:15px;line-height:23px;color:${C.text};`;
const LINK_STYLE = `color:${C.accent};text-decoration:underline;`;
/** Separación entre los párrafos y listas de un mismo bloque. */
const RICH_BLOCK_GAP = '12px';

const inlineHtml = (node: RichTextInline, context: EmailContext): string => {
  if (node.type === 'hardBreak') {
    return '<br>';
  }
  let html = htmlText(node.text, context);
  const marks = new Set((node.marks ?? []).map((mark) => mark.type));
  // Orden fijo de anidado, sin importar el orden en que lleguen las marcas.
  if (marks.has('underline')) {
    html = `<u>${html}</u>`;
  }
  if (marks.has('italic')) {
    html = `<em>${html}</em>`;
  }
  if (marks.has('bold')) {
    html = `<strong>${html}</strong>`;
  }
  const link = node.marks?.find((mark) => mark.type === 'link');
  if (link?.type === 'link') {
    const href = resolveButtonUrl(link.attrs.href, context);
    if (href !== null) {
      html = `<a href="${escapeHtml(href)}" target="_blank" rel="noopener" style="${LINK_STYLE}">${html}</a>`;
    }
  }
  return html;
};

const paragraphInlineHtml = (paragraph: RichTextParagraph, context: EmailContext): string => {
  const html = (paragraph.content ?? []).map((node) => inlineHtml(node, context)).join('');
  return html === '' ? '&nbsp;' : html;
};

export const richTextHtml = (doc: RichTextDoc, context: EmailContext): string =>
  doc.content
    .map((block, index) => {
      const margin = index === 0 ? '0' : `${RICH_BLOCK_GAP} 0 0`;
      if (block.type === 'paragraph') {
        return `<p style="margin:${margin};${TEXT_STYLE}">${paragraphInlineHtml(block, context)}</p>`;
      }
      const tag = block.type === 'orderedList' ? 'ol' : 'ul';
      const items = block.content
        .map(
          (item, itemIndex) =>
            `<li style="margin:${itemIndex === block.content.length - 1 ? '0' : '0 0 4px'};">` +
            item.content.map((paragraph) => paragraphInlineHtml(paragraph, context)).join('<br>') +
            `</li>`,
        )
        .join('');
      return `<${tag} style="margin:${margin};padding:0 0 0 24px;${TEXT_STYLE}">${items}</${tag}>`;
    })
    .join('');

const inlineText = (node: RichTextInline, context: EmailContext): string => {
  if (node.type === 'hardBreak') {
    return '\n';
  }
  const text = normalizeNewlines(substitute(node.text, context));
  const link = node.marks?.find((mark) => mark.type === 'link');
  if (link?.type !== 'link') {
    return text;
  }
  const href = resolveButtonUrl(link.attrs.href, context);
  return href === null || href === text.trim() ? text : `${text} (${href})`;
};

const paragraphText = (paragraph: RichTextParagraph, context: EmailContext): string =>
  (paragraph.content ?? []).map((node) => inlineText(node, context)).join('');

/** Texto plano: párrafos separados por línea en blanco, ítems "- " o "1. ", enlaces "texto (url)". */
export const richTextPlain = (doc: RichTextDoc, context: EmailContext): string =>
  doc.content
    .map((block) =>
      block.type === 'paragraph'
        ? paragraphText(block, context)
        : block.content
            .map(
              (item, index) =>
                `${block.type === 'orderedList' ? `${index + 1}.` : '-'} ` +
                item.content.map((paragraph) => paragraphText(paragraph, context)).join('\n'),
            )
            .join('\n'),
    )
    .join('\n\n')
    .trim();

// ---------- Imagen ----------

/** Ancho final: el pedido, o el natural limitado al máximo; alto proporcional. */
export const imageBox = (block: ImageBlock, asset: EmailImageAsset): { width: number; height: number } => {
  const width = block.width ?? Math.min(asset.width, EMAIL_DESIGN_LIMITS.imageMaxWidth);
  return { width, height: Math.max(1, Math.round((width * asset.height) / asset.width)) };
};

const imageHtml = (block: ImageBlock, context: EmailContext, assets: EmailAssetLookup): string => {
  const asset = assets.get(block.assetId.toLowerCase());
  if (!asset) {
    return '';
  }
  const { width, height } = imageBox(block, asset);
  const centered = block.align === 'center';
  const img =
    `<img src="${escapeHtml(asset.url)}" alt="${escapeHtml(singleLine(substitute(block.alt, context)))}" ` +
    `width="${width}" height="${height}" border="0" ` +
    `style="display:block;width:${width}px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;${centered ? 'margin:0 auto;' : ''}">`;
  const href = block.href === undefined ? null : resolveButtonUrl(block.href, context);
  const inner =
    href === null ? img : `<a href="${escapeHtml(href)}" target="_blank" rel="noopener" style="text-decoration:none;">${img}</a>`;
  return `<tr><td align="${centered ? 'center' : 'left'}" style="padding:0 32px 16px;">${inner}</td></tr>`;
};

const blockHtml = (block: EmailBlock, context: EmailContext, assets: EmailAssetLookup): string => {
  switch (block.type) {
    case 'heading':
      return row(
        `<h1 style="margin:0;font-family:${EMAIL_FONT_STACK};font-size:22px;line-height:30px;font-weight:bold;color:${C.text};">${htmlText(block.text, context)}</h1>`,
      );
    case 'paragraph':
      return row(richTextHtml(block.content, context));
    case 'button': {
      const href = resolveButtonUrl(block.url, context);
      if (href === null) {
        return '';
      }
      return row(
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
          `<td align="center" bgcolor="${C.accent}" style="border-radius:4px;background-color:${C.accent};">` +
          `<a href="${escapeHtml(href)}" target="_blank" rel="noopener" style="display:inline-block;padding:12px 24px;font-family:${EMAIL_FONT_STACK};font-size:15px;line-height:20px;font-weight:bold;color:${C.accentText};text-decoration:none;border-radius:4px;">${htmlText(block.label, context)}</a>` +
          `</td></tr></table>`,
        '8px 32px 24px',
      );
    }
    case 'divider':
      return row(
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid ${C.border};font-size:0;line-height:0;">&nbsp;</td></tr></table>`,
        '8px 32px 24px',
      );
    case 'keyValueList': {
      const rows = block.items
        .map(
          (item) =>
            `<tr>` +
            `<td valign="top" style="padding:6px 12px 6px 0;width:40%;font-family:${EMAIL_FONT_STACK};font-size:14px;line-height:20px;font-weight:bold;color:${C.mutedText};border-bottom:1px solid ${C.border};">${htmlText(item.label, context)}</td>` +
            `<td valign="top" style="padding:6px 0;font-family:${EMAIL_FONT_STACK};font-size:14px;line-height:20px;color:${C.text};border-bottom:1px solid ${C.border};">${htmlText(item.value, context)}</td>` +
            `</tr>`,
        )
        .join('');
      return row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>`);
    }
    case 'callout': {
      const background = block.tone === 'warning' ? C.warningBackground : C.infoBackground;
      const border = block.tone === 'warning' ? C.warningBorder : C.infoBorder;
      return row(
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
          `<td style="padding:12px 16px;background-color:${background};border-left:4px solid ${border};font-family:${EMAIL_FONT_STACK};font-size:14px;line-height:21px;color:${C.text};">${htmlText(block.text, context)}</td>` +
          `</tr></table>`,
      );
    }
    case 'spacer':
      return `<tr><td style="height:${SPACER_PX[block.size]}px;font-size:0;line-height:0;">&nbsp;</td></tr>`;
    case 'image':
      return imageHtml(block, context, assets);
  }
};

const headerHtml = (brand: EmailBrand): string => {
  const logo = brand.logoUrl !== null && isHttpsLiteral(brand.logoUrl) ? brand.logoUrl : null;
  const inner =
    logo !== null
      ? `<img src="${escapeHtml(logo)}" alt="${escapeHtml(brand.name)}" height="48" style="display:block;height:48px;width:auto;border:0;outline:none;text-decoration:none;">`
      : `<span style="font-family:${EMAIL_FONT_STACK};font-size:20px;line-height:28px;font-weight:bold;color:${C.headerText};">${escapeHtml(brand.name)}</span>`;
  return `<tr><td style="padding:20px 32px;background-color:${C.headerBackground};" bgcolor="${C.headerBackground}">${inner}</td></tr>`;
};

const footerHtml = (brand: EmailBrand): string =>
  `<tr><td style="padding:16px 32px 24px;border-top:1px solid ${C.border};font-family:${EMAIL_FONT_STACK};font-size:12px;line-height:18px;color:${C.mutedText};">${escapeHtml(EMAIL_FOOTER_TEXT(brand.name))}</td></tr>`;

export const renderEmailHtml = (
  subject: string,
  blocks: ReadonlyArray<EmailBlock>,
  context: EmailContext,
  brand: EmailBrand = DEFAULT_EMAIL_BRAND,
  assets: EmailAssetLookup = NO_ASSETS,
): string => {
  const content = blocks.map((block) => blockHtml(block, context, assets)).join('');
  return (
    `<!DOCTYPE html>` +
    `<html lang="es"><head>` +
    `<meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="x-apple-disable-message-reformatting">` +
    `<title>${escapeHtml(renderSubject(subject, context))}</title>` +
    `</head>` +
    `<body style="margin:0;padding:0;background-color:${C.pageBackground};">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.pageBackground}" style="background-color:${C.pageBackground};">` +
    `<tr><td align="center" style="padding:24px 12px;">` +
    `<table role="presentation" width="${EMAIL_CONTENT_WIDTH}" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:${EMAIL_CONTENT_WIDTH}px;background-color:${C.cardBackground};border:1px solid ${C.border};">` +
    headerHtml(brand) +
    `<tr><td style="height:24px;font-size:0;line-height:0;">&nbsp;</td></tr>` +
    content +
    footerHtml(brand) +
    `</table>` +
    `</td></tr></table>` +
    `</body></html>`
  );
};

const blockText = (block: EmailBlock, context: EmailContext, assets: EmailAssetLookup): string | null => {
  const plain = (value: string): string => normalizeNewlines(substitute(value, context)).trim();
  switch (block.type) {
    case 'heading':
      return plain(block.text);
    case 'paragraph':
      return richTextPlain(block.content, context);
    case 'callout':
      return plain(block.text);
    case 'button': {
      const href = resolveButtonUrl(block.url, context);
      return href === null ? null : `${plain(block.label)}: ${href}`;
    }
    case 'divider':
      return '----------------------------------------';
    case 'keyValueList':
      return block.items.map((item) => `${plain(item.label)}: ${plain(item.value)}`).join('\n');
    case 'spacer':
      return null;
    case 'image': {
      if (!assets.has(block.assetId.toLowerCase())) {
        return null;
      }
      const href = block.href === undefined ? null : resolveButtonUrl(block.href, context);
      const label = `[Imagen: ${singleLine(substitute(block.alt, context))}]`;
      return href === null ? label : `${label} (${href})`;
    }
  }
};

export const renderEmailPlainText = (
  blocks: ReadonlyArray<EmailBlock>,
  context: EmailContext,
  brand: EmailBrand = DEFAULT_EMAIL_BRAND,
  assets: EmailAssetLookup = NO_ASSETS,
): string => {
  const parts = blocks
    .map((block) => blockText(block, context, assets))
    .filter((part): part is string => part !== null && part !== '');
  return [...parts, `-- \n${EMAIL_FOOTER_TEXT(brand.name)}`].join('\n\n');
};

export const renderEmail = (
  design: { readonly subject: string; readonly blocks: ReadonlyArray<EmailBlock> },
  context: EmailContext,
  brand: EmailBrand = DEFAULT_EMAIL_BRAND,
  assets: EmailAssetLookup = NO_ASSETS,
): RenderedEmail => ({
  subject: renderSubject(design.subject, context),
  html: renderEmailHtml(design.subject, design.blocks, context, brand, assets),
  text: renderEmailPlainText(design.blocks, context, brand, assets),
});
