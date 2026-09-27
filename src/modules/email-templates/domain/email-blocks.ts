/**
 * Diseño de una plantilla de correo como lista de bloques de un catálogo CERRADO (al estilo React Email, sin
 * dependencias): el administrador compone el contenido, el sistema pone la identidad (layout en email-layout.ts) y
 * el HTML lo genera siempre el renderizador propio (email-renderer.ts). Ningún bloque admite marcado: todo texto,
 * literal o de una variable, se escapa al renderizar.
 *
 * Los textos admiten variables `{{token}}` del catálogo del tipo (email-template-catalog.ts). El URL de un botón, de
 * un enlace del párrafo y de una imagen es una sola variable (`{{auth.resetUrl}}`) o un literal `https://`
 * (email-url.ts); el valor de la variable se valida como http(s) al renderizar.
 *
 * El párrafo es texto enriquecido (rich-text.ts: documento Tiptap/ProseMirror de esquema cerrado, nunca HTML). La
 * imagen apunta a un asset subido (email_asset) por su id; que exista lo comprueba el servicio al guardar y al
 * previsualizar.
 */

import { isAllowedDesignUrl } from './email-url.js';
import {
  RICH_TEXT_LIMITS,
  normalizeRichTextDoc,
  richTextTexts,
  validateRichTextDoc,
  type RichTextDoc,
} from './rich-text.js';

export { buttonUrlToken, isHttpsLiteral } from './email-url.js';

export const EMAIL_BLOCK_TYPES = [
  'heading',
  'paragraph',
  'button',
  'divider',
  'keyValueList',
  'callout',
  'spacer',
  'image',
] as const;

export type EmailBlockType = (typeof EMAIL_BLOCK_TYPES)[number];

export const CALLOUT_TONES = ['info', 'warning'] as const;
export type CalloutTone = (typeof CALLOUT_TONES)[number];

export const SPACER_SIZES = ['sm', 'md', 'lg'] as const;
export type SpacerSize = (typeof SPACER_SIZES)[number];

export const IMAGE_ALIGNS = ['left', 'center'] as const;
export type ImageAlign = (typeof IMAGE_ALIGNS)[number];

export interface HeadingBlock {
  readonly type: 'heading';
  readonly text: string;
}

export interface ParagraphBlock {
  readonly type: 'paragraph';
  /** Documento de texto enriquecido (rich-text.ts). */
  readonly content: RichTextDoc;
}

export interface ButtonBlock {
  readonly type: 'button';
  readonly label: string;
  readonly url: string;
}

export interface DividerBlock {
  readonly type: 'divider';
}

export interface KeyValueItem {
  readonly label: string;
  readonly value: string;
}

export interface KeyValueListBlock {
  readonly type: 'keyValueList';
  readonly items: ReadonlyArray<KeyValueItem>;
}

export interface CalloutBlock {
  readonly type: 'callout';
  readonly tone: CalloutTone;
  readonly text: string;
}

export interface SpacerBlock {
  readonly type: 'spacer';
  readonly size: SpacerSize;
}

export interface ImageBlock {
  readonly type: 'image';
  /** Id de email_asset (imagen subida). */
  readonly assetId: string;
  /** Texto alternativo; admite variables. */
  readonly alt: string;
  /** Ancho en px (imageMinWidth..imageMaxWidth). Sin él: el ancho natural, limitado a imageMaxWidth. */
  readonly width?: number;
  readonly align: ImageAlign;
  /** Enlace opcional: variable del catálogo o https://. */
  readonly href?: string;
}

export type EmailBlock =
  | HeadingBlock
  | ParagraphBlock
  | ButtonBlock
  | DividerBlock
  | KeyValueListBlock
  | CalloutBlock
  | SpacerBlock
  | ImageBlock;

export const EMAIL_DESIGN_LIMITS = {
  subjectMaxLength: 200,
  minBlocks: 1,
  maxBlocks: 40,
  headingMaxLength: 200,
  /** Párrafo: caracteres de texto sumando todo el documento. */
  paragraphMaxLength: RICH_TEXT_LIMITS.maxTextLength,
  /** Párrafo: nodos del documento (párrafos, listas, ítems, textos y saltos). */
  paragraphMaxNodes: RICH_TEXT_LIMITS.maxNodes,
  buttonLabelMaxLength: 60,
  urlMaxLength: 500,
  keyValueMinItems: 1,
  keyValueMaxItems: 20,
  keyValueLabelMaxLength: 80,
  keyValueValueMaxLength: 500,
  calloutMaxLength: 1000,
  imageAltMaxLength: 200,
  imageMinWidth: 50,
  imageMaxWidth: 560,
  maxImages: 10,
} as const;

/** Campo editable de un bloque, para que el frontend arme el formulario sin duplicar reglas. */
export interface EmailBlockFieldSpec {
  readonly name: string;
  readonly label: string;
  /**
   * richText: documento Tiptap (rich-text.ts), maxLength = texto total. image: id de un asset subido (selector de
   * GET /email-templates/assets). integer: número entre minValue y maxValue.
   */
  readonly kind: 'text' | 'multiline' | 'url' | 'enum' | 'items' | 'richText' | 'image' | 'integer';
  readonly required: boolean;
  readonly maxLength: number | null;
  readonly allowsVariables: boolean;
  readonly options: ReadonlyArray<string> | null;
  /** Solo kind = items: mínimo y máximo de filas; cada fila tiene label y value. */
  readonly minItems: number | null;
  readonly maxItems: number | null;
  /** Solo kind = integer. */
  readonly minValue: number | null;
  readonly maxValue: number | null;
}

export interface EmailBlockSpec {
  readonly type: EmailBlockType;
  readonly label: string;
  readonly description: string;
  readonly fields: ReadonlyArray<EmailBlockFieldSpec>;
}

const field = (
  spec: Pick<EmailBlockFieldSpec, 'name' | 'label' | 'kind'> & Partial<EmailBlockFieldSpec>,
): EmailBlockFieldSpec => ({
  required: true,
  maxLength: null,
  allowsVariables: false,
  options: null,
  minItems: null,
  maxItems: null,
  minValue: null,
  maxValue: null,
  ...spec,
});

const L = EMAIL_DESIGN_LIMITS;

export const EMAIL_BLOCK_CATALOG: ReadonlyArray<EmailBlockSpec> = [
  {
    type: 'heading',
    label: 'Título',
    description: 'Título destacado del correo',
    fields: [field({ name: 'text', label: 'Texto', kind: 'text', maxLength: L.headingMaxLength, allowsVariables: true })],
  },
  {
    type: 'paragraph',
    label: 'Párrafo',
    description: 'Texto con formato: negrita, cursiva, subrayado, enlaces y listas',
    fields: [
      field({ name: 'content', label: 'Texto', kind: 'richText', maxLength: L.paragraphMaxLength, allowsVariables: true }),
    ],
  },
  {
    type: 'button',
    label: 'Botón',
    description: 'Enlace destacado. El URL es una variable del catálogo o un literal https://',
    fields: [
      field({ name: 'label', label: 'Texto del botón', kind: 'text', maxLength: L.buttonLabelMaxLength, allowsVariables: true }),
      field({ name: 'url', label: 'Enlace', kind: 'url', maxLength: L.urlMaxLength, allowsVariables: true }),
    ],
  },
  { type: 'divider', label: 'Separador', description: 'Línea horizontal', fields: [] },
  {
    type: 'keyValueList',
    label: 'Lista de datos',
    description: 'Pares etiqueta / valor (por ejemplo, Usuario: {{user.username}})',
    fields: [
      field({
        name: 'items',
        label: 'Filas',
        kind: 'items',
        allowsVariables: true,
        maxLength: L.keyValueValueMaxLength,
        minItems: L.keyValueMinItems,
        maxItems: L.keyValueMaxItems,
      }),
    ],
  },
  {
    type: 'callout',
    label: 'Nota destacada',
    description: 'Recuadro para avisos o advertencias',
    fields: [
      field({ name: 'tone', label: 'Tono', kind: 'enum', options: CALLOUT_TONES }),
      field({ name: 'text', label: 'Texto', kind: 'multiline', maxLength: L.calloutMaxLength, allowsVariables: true }),
    ],
  },
  {
    type: 'spacer',
    label: 'Espacio',
    description: 'Espacio vertical en blanco',
    fields: [field({ name: 'size', label: 'Tamaño', kind: 'enum', options: SPACER_SIZES })],
  },
  {
    type: 'image',
    label: 'Imagen',
    description: `Imagen PNG o JPG subida desde el editor (máximo ${L.maxImages} por correo)`,
    fields: [
      field({ name: 'assetId', label: 'Imagen', kind: 'image' }),
      field({ name: 'alt', label: 'Texto alternativo', kind: 'text', maxLength: L.imageAltMaxLength, allowsVariables: true }),
      field({
        name: 'width',
        label: 'Ancho (px)',
        kind: 'integer',
        required: false,
        minValue: L.imageMinWidth,
        maxValue: L.imageMaxWidth,
      }),
      field({ name: 'align', label: 'Alineación', kind: 'enum', options: IMAGE_ALIGNS }),
      field({ name: 'href', label: 'Enlace', kind: 'url', required: false, maxLength: L.urlMaxLength, allowsVariables: true }),
    ],
  },
];

export interface EmailDesignIssue {
  readonly field: string;
  readonly message: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

type FieldCheck = (value: unknown, path: string, issues: EmailDesignIssue[]) => void;

const text =
  (maxLength: number): FieldCheck =>
  (value, path, issues) => {
    if (typeof value !== 'string' || value.trim() === '') {
      issues.push({ field: path, message: 'Debe ser un texto no vacío' });
    } else if (value.length > maxLength) {
      issues.push({ field: path, message: `Máximo ${maxLength} caracteres` });
    }
  };

const oneOf =
  (options: ReadonlyArray<string>): FieldCheck =>
  (value, path, issues) => {
    if (typeof value !== 'string' || !options.includes(value)) {
      issues.push({ field: path, message: `Debe ser uno de: ${options.join(', ')}` });
    }
  };

const url: FieldCheck = (value, path, issues) => {
  text(L.urlMaxLength)(value, path, issues);
  if (typeof value === 'string' && value.trim() !== '' && !isAllowedDesignUrl(value)) {
    issues.push({ field: path, message: 'Debe ser una variable del catálogo ({{...}}) o un enlace https://' });
  }
};

const items: FieldCheck = (value, path, issues) => {
  if (!Array.isArray(value)) {
    issues.push({ field: path, message: 'Debe ser una lista de filas' });
    return;
  }
  if (value.length < L.keyValueMinItems || value.length > L.keyValueMaxItems) {
    issues.push({ field: path, message: `Entre ${L.keyValueMinItems} y ${L.keyValueMaxItems} filas` });
  }
  value.forEach((item: unknown, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(item)) {
      issues.push({ field: itemPath, message: 'Cada fila es un objeto { label, value }' });
      return;
    }
    for (const key of Object.keys(item)) {
      if (key !== 'label' && key !== 'value') {
        issues.push({ field: `${itemPath}.${key}`, message: 'Campo no permitido' });
      }
    }
    text(L.keyValueLabelMaxLength)(item['label'], `${itemPath}.label`, issues);
    text(L.keyValueValueMaxLength)(item['value'], `${itemPath}.value`, issues);
  });
};

const richText: FieldCheck = (value, path, issues) => {
  issues.push(...validateRichTextDoc(value, path));
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const uuid: FieldCheck = (value, path, issues) => {
  if (typeof value !== 'string' || !UUID.test(value)) {
    issues.push({ field: path, message: 'Debe ser el id (uuid) de una imagen subida' });
  }
};

const integer =
  (min: number, max: number): FieldCheck =>
  (value, path, issues) => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      issues.push({ field: path, message: `Debe ser un entero entre ${min} y ${max}` });
    }
  };

/** Campo opcional: ausente es válido; presente (incluido null) se valida con `check`. */
const optional =
  (check: FieldCheck): FieldCheck =>
  (value, path, issues) => {
    if (value !== undefined) {
      check(value, path, issues);
    }
  };

const BLOCK_FIELDS: Record<EmailBlockType, Record<string, FieldCheck>> = {
  heading: { text: text(L.headingMaxLength) },
  paragraph: { content: richText },
  button: { label: text(L.buttonLabelMaxLength), url },
  divider: {},
  keyValueList: { items },
  callout: { tone: oneOf(CALLOUT_TONES), text: text(L.calloutMaxLength) },
  spacer: { size: oneOf(SPACER_SIZES) },
  image: {
    assetId: uuid,
    alt: text(L.imageAltMaxLength),
    width: optional(integer(L.imageMinWidth, L.imageMaxWidth)),
    align: oneOf(IMAGE_ALIGNS),
    href: optional(url),
  },
};

const isBlockType = (value: unknown): value is EmailBlockType =>
  typeof value === 'string' && (EMAIL_BLOCK_TYPES as ReadonlyArray<string>).includes(value);

/**
 * Validación estricta de la estructura (no de las variables: eso depende del tipo, ver email-template-catalog.ts;
 * ni de que las imágenes existan: eso lo comprueba el servicio). Rechaza tipos desconocidos, campos de más o de
 * menos, longitudes, número de bloques y de imágenes fuera de límite.
 */
export const validateEmailBlocks = (blocks: unknown): ReadonlyArray<EmailDesignIssue> => {
  const issues: EmailDesignIssue[] = [];
  if (!Array.isArray(blocks)) {
    return [{ field: 'blocks', message: 'Debe ser una lista de bloques' }];
  }
  if (blocks.length < L.minBlocks || blocks.length > L.maxBlocks) {
    issues.push({ field: 'blocks', message: `Entre ${L.minBlocks} y ${L.maxBlocks} bloques` });
  }
  blocks.forEach((block: unknown, index) => {
    const path = `blocks[${index}]`;
    if (!isRecord(block) || !isBlockType(block['type'])) {
      issues.push({ field: `${path}.type`, message: `Tipo de bloque no permitido; use: ${EMAIL_BLOCK_TYPES.join(', ')}` });
      return;
    }
    const checks = BLOCK_FIELDS[block['type']];
    for (const key of Object.keys(block)) {
      if (key !== 'type' && !(key in checks)) {
        issues.push({ field: `${path}.${key}`, message: 'Campo no permitido para este bloque' });
      }
    }
    for (const [name, check] of Object.entries(checks)) {
      check(block[name], `${path}.${name}`, issues);
    }
  });
  const images = blocks.filter((block: unknown) => isRecord(block) && block['type'] === 'image').length;
  if (images > L.maxImages) {
    issues.push({ field: 'blocks', message: `Máximo ${L.maxImages} imágenes por correo` });
  }
  return issues;
};

/** Textos del bloque donde pueden ir variables (incluye los URL de botón, enlaces e imagen). */
export const blockTexts = (block: EmailBlock): ReadonlyArray<string> => {
  switch (block.type) {
    case 'heading':
    case 'callout':
      return [block.text];
    case 'paragraph':
      return richTextTexts(block.content);
    case 'button':
      return [block.label, block.url];
    case 'keyValueList':
      return block.items.flatMap((item) => [item.label, item.value]);
    case 'image':
      return block.href === undefined ? [block.alt] : [block.alt, block.href];
    case 'divider':
    case 'spacer':
      return [];
  }
};

/** Copia solo los campos conocidos (tras validar): lo que se guarda en BD es exactamente el catálogo. */
export const normalizeEmailBlocks = (blocks: ReadonlyArray<EmailBlock>): ReadonlyArray<EmailBlock> =>
  blocks.map((block): EmailBlock => {
    switch (block.type) {
      case 'heading':
        return { type: 'heading', text: block.text };
      case 'paragraph':
        return { type: 'paragraph', content: normalizeRichTextDoc(block.content) };
      case 'button':
        return { type: 'button', label: block.label, url: block.url.trim() };
      case 'divider':
        return { type: 'divider' };
      case 'keyValueList':
        return { type: 'keyValueList', items: block.items.map((item) => ({ label: item.label, value: item.value })) };
      case 'callout':
        return { type: 'callout', tone: block.tone, text: block.text };
      case 'spacer':
        return { type: 'spacer', size: block.size };
      case 'image':
        return {
          type: 'image',
          assetId: block.assetId.toLowerCase(),
          alt: block.alt,
          ...(block.width === undefined ? {} : { width: block.width }),
          align: block.align,
          ...(block.href === undefined ? {} : { href: block.href.trim() }),
        };
    }
  });

/** Ids de las imágenes del diseño (en minúsculas), sin repetir. */
export const imageAssetIds = (blocks: ReadonlyArray<EmailBlock>): ReadonlyArray<string> => [
  ...new Set(blocks.flatMap((block) => (block.type === 'image' ? [block.assetId.toLowerCase()] : []))),
];
