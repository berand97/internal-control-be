import { isAllowedDesignUrl } from './email-url.js';

/**
 * Texto enriquecido del bloque `paragraph`: un documento JSON al estilo ProseMirror, el que produce Tiptap con
 * `editor.getJSON()`, con un esquema CERRADO. Nunca HTML: el backend valida la estructura y el renderizador propio
 * (email-renderer.ts) escribe el único marcado, escapando todo texto.
 *
 * Esquema aceptado (cualquier otro nodo, marca, atributo o propiedad se rechaza con el campo exacto):
 *   doc          { type: 'doc', content: (paragraph | bulletList | orderedList)[1..] }
 *   paragraph    { type: 'paragraph', content?: (text | hardBreak)[] }         sin content = línea vacía
 *   bulletList   { type: 'bulletList', content: listItem[1..] }
 *   orderedList  { type: 'orderedList', content: listItem[1..] }              siempre empieza en 1; sin attrs
 *   listItem     { type: 'listItem', content: paragraph[1..] }                 SIN listas anidadas (un solo nivel)
 *   text         { type: 'text', text: string no vacío, marks?: mark[] }
 *   hardBreak    { type: 'hardBreak', marks?: mark[] }                          las marcas de un salto se ignoran
 *   mark         { type: 'bold' } | { type: 'italic' } | { type: 'underline' } | { type: 'link', attrs: { href } }
 *
 * - `href`: exactamente una variable del catálogo (`{{auth.loginUrl}}`) o un literal https:// (misma regla que el
 *   URL del botón). Los atributos que Tiptap agrega por defecto (link.target, link.rel, link.class,
 *   paragraph.textAlign, orderedList.start / type...) se RECHAZAN: el frontend debe quitarlos antes de enviar.
 * - Una variable no puede quedar partida por un formato o un salto (`{{user.` en negrita y `email}}` sin ella): se
 *   rechaza el texto con `{{` o `}}` sueltos.
 * - Límites: RICH_TEXT_LIMITS (texto total, número de nodos). La profundidad es fija por el propio esquema.
 */

export const RICH_TEXT_MARK_TYPES = ['bold', 'italic', 'underline', 'link'] as const;
export type RichTextMarkType = (typeof RICH_TEXT_MARK_TYPES)[number];

export const RICH_TEXT_LIMITS = {
  /** Caracteres de texto sumando todos los nodos text (los saltos no cuentan). */
  maxTextLength: 2000,
  /** Nodos del documento sin contar doc: párrafos, listas, ítems, textos y saltos. */
  maxNodes: 200,
  hrefMaxLength: 500,
} as const;

export type RichTextMark =
  | { readonly type: 'bold' }
  | { readonly type: 'italic' }
  | { readonly type: 'underline' }
  | { readonly type: 'link'; readonly attrs: { readonly href: string } };

export interface RichTextText {
  readonly type: 'text';
  readonly text: string;
  readonly marks?: ReadonlyArray<RichTextMark>;
}

export interface RichTextHardBreak {
  readonly type: 'hardBreak';
}

export type RichTextInline = RichTextText | RichTextHardBreak;

export interface RichTextParagraph {
  readonly type: 'paragraph';
  readonly content?: ReadonlyArray<RichTextInline>;
}

export interface RichTextListItem {
  readonly type: 'listItem';
  readonly content: ReadonlyArray<RichTextParagraph>;
}

export interface RichTextList {
  readonly type: 'bulletList' | 'orderedList';
  readonly content: ReadonlyArray<RichTextListItem>;
}

export type RichTextBlock = RichTextParagraph | RichTextList;

export interface RichTextDoc {
  readonly type: 'doc';
  readonly content: ReadonlyArray<RichTextBlock>;
}

export interface RichTextIssue {
  readonly field: string;
  readonly message: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const TOKEN_PATTERN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

interface Walk {
  readonly issues: RichTextIssue[];
  nodes: number;
  textLength: number;
  hasVisibleText: boolean;
}

/** Solo las claves permitidas; `type` siempre lo está. */
const onlyKeys = (node: Record<string, unknown>, allowed: ReadonlyArray<string>, path: string, walk: Walk): void => {
  for (const key of Object.keys(node)) {
    if (key !== 'type' && !allowed.includes(key)) {
      walk.issues.push({ field: `${path}.${key}`, message: 'Propiedad no permitida en el texto enriquecido' });
    }
  }
};

/** Arreglo `content` obligatorio y no vacío. */
const contentArray = (node: Record<string, unknown>, path: string, walk: Walk): ReadonlyArray<unknown> | null => {
  const content = node['content'];
  if (!Array.isArray(content) || content.length === 0) {
    walk.issues.push({ field: `${path}.content`, message: 'Debe ser una lista no vacía de nodos' });
    return null;
  }
  return content;
};

const checkMarks = (value: unknown, path: string, walk: Walk): void => {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    walk.issues.push({ field: path, message: 'Debe ser una lista de marcas' });
    return;
  }
  const seen = new Set<string>();
  value.forEach((mark: unknown, index) => {
    const markPath = `${path}[${index}]`;
    if (!isRecord(mark) || !(RICH_TEXT_MARK_TYPES as ReadonlyArray<unknown>).includes(mark['type'])) {
      walk.issues.push({
        field: `${markPath}.type`,
        message: `Marca no permitida; use: ${RICH_TEXT_MARK_TYPES.join(', ')}`,
      });
      return;
    }
    const type = mark['type'] as RichTextMarkType;
    if (seen.has(type)) {
      walk.issues.push({ field: `${markPath}.type`, message: 'Marca repetida' });
    }
    seen.add(type);
    if (type !== 'link') {
      onlyKeys(mark, [], markPath, walk);
      return;
    }
    onlyKeys(mark, ['attrs'], markPath, walk);
    const attrs = mark['attrs'];
    if (!isRecord(attrs)) {
      walk.issues.push({ field: `${markPath}.attrs`, message: 'El enlace necesita attrs.href' });
      return;
    }
    for (const key of Object.keys(attrs)) {
      if (key !== 'href') {
        walk.issues.push({
          field: `${markPath}.attrs.${key}`,
          message: 'Atributo no permitido en el enlace (solo href): quítelo antes de enviar',
        });
      }
    }
    const href = attrs['href'];
    if (typeof href !== 'string' || href.trim() === '') {
      walk.issues.push({ field: `${markPath}.attrs.href`, message: 'Debe ser un texto no vacío' });
    } else if (href.length > RICH_TEXT_LIMITS.hrefMaxLength) {
      walk.issues.push({ field: `${markPath}.attrs.href`, message: `Máximo ${RICH_TEXT_LIMITS.hrefMaxLength} caracteres` });
    } else if (!isAllowedDesignUrl(href)) {
      walk.issues.push({
        field: `${markPath}.attrs.href`,
        message: 'Debe ser una variable del catálogo ({{...}}) o un enlace https://',
      });
    }
  });
};

const checkInline = (node: unknown, path: string, walk: Walk): void => {
  walk.nodes += 1;
  if (!isRecord(node) || (node['type'] !== 'text' && node['type'] !== 'hardBreak')) {
    walk.issues.push({ field: `${path}.type`, message: 'Dentro de un párrafo solo se admiten text y hardBreak' });
    return;
  }
  if (node['type'] === 'hardBreak') {
    onlyKeys(node, ['marks'], path, walk);
    checkMarks(node['marks'], `${path}.marks`, walk);
    return;
  }
  onlyKeys(node, ['text', 'marks'], path, walk);
  const text = node['text'];
  if (typeof text !== 'string' || text === '') {
    walk.issues.push({ field: `${path}.text`, message: 'Debe ser un texto no vacío' });
  } else {
    walk.textLength += text.length;
    if (text.trim() !== '') {
      walk.hasVisibleText = true;
    }
    if (/\{\{|\}\}/.test(text.replace(TOKEN_PATTERN, ''))) {
      walk.issues.push({
        field: `${path}.text`,
        message: 'Variable incompleta o partida por un formato: aplique el formato a toda la {{variable}}',
      });
    }
  }
  checkMarks(node['marks'], `${path}.marks`, walk);
};

const checkParagraph = (node: unknown, path: string, walk: Walk): void => {
  walk.nodes += 1;
  if (!isRecord(node) || node['type'] !== 'paragraph') {
    walk.issues.push({ field: `${path}.type`, message: 'Se esperaba un paragraph' });
    return;
  }
  onlyKeys(node, ['content'], path, walk);
  const content = node['content'];
  if (content === undefined) {
    return;
  }
  if (!Array.isArray(content)) {
    walk.issues.push({ field: `${path}.content`, message: 'Debe ser una lista de nodos' });
    return;
  }
  content.forEach((child: unknown, index) => checkInline(child, `${path}.content[${index}]`, walk));
};

const checkList = (node: Record<string, unknown>, path: string, walk: Walk): void => {
  onlyKeys(node, ['content'], path, walk);
  const items = contentArray(node, path, walk);
  items?.forEach((item: unknown, index) => {
    const itemPath = `${path}.content[${index}]`;
    walk.nodes += 1;
    if (!isRecord(item) || item['type'] !== 'listItem') {
      walk.issues.push({ field: `${itemPath}.type`, message: 'Una lista solo contiene listItem' });
      return;
    }
    onlyKeys(item, ['content'], itemPath, walk);
    const paragraphs = contentArray(item, itemPath, walk);
    paragraphs?.forEach((child: unknown, childIndex) => {
      const childPath = `${itemPath}.content[${childIndex}]`;
      if (isRecord(child) && (child['type'] === 'bulletList' || child['type'] === 'orderedList')) {
        walk.nodes += 1;
        walk.issues.push({ field: `${childPath}.type`, message: 'No se admiten listas anidadas' });
        return;
      }
      checkParagraph(child, childPath, walk);
    });
  });
};

/**
 * Valida un documento contra el esquema cerrado. `path` es el campo del bloque (p. ej. `blocks[2].content`); los
 * problemas llevan la ruta exacta del nodo (`blocks[2].content.content[0].content[1].marks[0].attrs.target`).
 */
export const validateRichTextDoc = (value: unknown, path: string): ReadonlyArray<RichTextIssue> => {
  const walk: Walk = { issues: [], nodes: 0, textLength: 0, hasVisibleText: false };
  if (!isRecord(value) || value['type'] !== 'doc') {
    return [{ field: path, message: 'Debe ser un documento { type: "doc", content: [...] }' }];
  }
  onlyKeys(value, ['content'], path, walk);
  const blocks = contentArray(value, path, walk);
  blocks?.forEach((block: unknown, index) => {
    const blockPath = `${path}.content[${index}]`;
    if (isRecord(block) && (block['type'] === 'bulletList' || block['type'] === 'orderedList')) {
      walk.nodes += 1;
      checkList(block, blockPath, walk);
      return;
    }
    if (!isRecord(block) || block['type'] !== 'paragraph') {
      walk.nodes += 1;
      walk.issues.push({ field: `${blockPath}.type`, message: 'Nodo no permitido; use: paragraph, bulletList, orderedList' });
      return;
    }
    checkParagraph(block, blockPath, walk);
  });
  if (walk.textLength > RICH_TEXT_LIMITS.maxTextLength) {
    walk.issues.push({ field: path, message: `Máximo ${RICH_TEXT_LIMITS.maxTextLength} caracteres de texto` });
  }
  if (walk.nodes > RICH_TEXT_LIMITS.maxNodes) {
    walk.issues.push({ field: path, message: `Máximo ${RICH_TEXT_LIMITS.maxNodes} nodos (párrafos, ítems, textos y saltos)` });
  }
  if (blocks !== null && walk.issues.length === 0 && !walk.hasVisibleText) {
    walk.issues.push({ field: path, message: 'El párrafo no tiene texto' });
  }
  return walk.issues;
};

const normalizeMarks = (marks: ReadonlyArray<RichTextMark> | undefined): ReadonlyArray<RichTextMark> =>
  (marks ?? []).map((mark): RichTextMark => (mark.type === 'link' ? { type: 'link', attrs: { href: mark.attrs.href.trim() } } : { type: mark.type }));

const normalizeParagraph = (paragraph: RichTextParagraph): RichTextParagraph => {
  const content = (paragraph.content ?? []).map((node): RichTextInline => {
    if (node.type === 'hardBreak') {
      return { type: 'hardBreak' };
    }
    const marks = normalizeMarks(node.marks);
    return marks.length > 0 ? { type: 'text', text: node.text, marks } : { type: 'text', text: node.text };
  });
  return content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' };
};

/** Copia solo lo del esquema (tras validar): sin marcas vacías ni marcas en los saltos. */
export const normalizeRichTextDoc = (doc: RichTextDoc): RichTextDoc => ({
  type: 'doc',
  content: doc.content.map((block): RichTextBlock =>
    block.type === 'paragraph'
      ? normalizeParagraph(block)
      : {
          type: block.type,
          content: block.content.map((item) => ({ type: 'listItem', content: item.content.map(normalizeParagraph) })),
        },
  ),
});

const paragraphsOf = (doc: RichTextDoc): ReadonlyArray<RichTextParagraph> =>
  doc.content.flatMap((block) => (block.type === 'paragraph' ? [block] : block.content.flatMap((item) => item.content)));

/** Textos donde pueden ir variables: cada nodo text y cada href. */
export const richTextTexts = (doc: RichTextDoc): ReadonlyArray<string> =>
  paragraphsOf(doc).flatMap((paragraph) =>
    (paragraph.content ?? []).flatMap((node) =>
      node.type === 'text'
        ? [node.text, ...(node.marks ?? []).flatMap((mark) => (mark.type === 'link' ? [mark.attrs.href] : []))]
        : [],
    ),
  );

/**
 * Texto plano → documento, sin pérdida: cada línea en blanco separa párrafos y cada salto simple es un hardBreak.
 * richTextToText(textToRichText(x)) === x para cualquier x (con saltos \n). La misma conversión, copiada, la usa la
 * migración 1767225820000.
 */
export const textToRichText = (text: string): RichTextDoc => ({
  type: 'doc',
  content: text
    .replace(/\r\n|\r/g, '\n')
    .split('\n\n')
    .map((part): RichTextParagraph => {
      const content: RichTextInline[] = [];
      part.split('\n').forEach((line, index) => {
        if (index > 0) {
          content.push({ type: 'hardBreak' });
        }
        if (line !== '') {
          content.push({ type: 'text', text: line });
        }
      });
      return content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' };
    }),
});

const paragraphText = (paragraph: RichTextParagraph): string =>
  (paragraph.content ?? [])
    .map((node) => {
      if (node.type === 'hardBreak') {
        return '\n';
      }
      const link = node.marks?.find((mark) => mark.type === 'link');
      return link && link.type === 'link' && link.attrs.href !== node.text ? `${node.text} (${link.attrs.href})` : node.text;
    })
    .join('');

/**
 * Documento → texto con las variables sin sustituir (para el down() de la migración). Pierde las marcas; un enlace
 * queda como "texto (href)"; cada ítem de lista es una línea "- " o "1. ".
 */
export const richTextToText = (doc: RichTextDoc): string =>
  doc.content
    .map((block) =>
      block.type === 'paragraph'
        ? paragraphText(block)
        : block.content
            .map((item, index) => `${block.type === 'orderedList' ? `${index + 1}.` : '-'} ${item.content.map(paragraphText).join('\n')}`)
            .join('\n'),
    )
    .join('\n\n');
