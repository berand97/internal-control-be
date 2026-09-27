/**
 * Diseño de una plantilla de correo como lista de bloques de un catálogo CERRADO (al estilo React Email, sin
 * dependencias): el administrador compone el contenido, el sistema pone la identidad (layout en email-layout.ts) y
 * el HTML lo genera siempre el renderizador propio (email-renderer.ts). Ningún bloque admite marcado: todo texto,
 * literal o de una variable, se escapa al renderizar.
 *
 * Los textos admiten variables `{{token}}` del catálogo del tipo (email-template-catalog.ts). El URL de un botón es
 * una sola variable (`{{auth.resetUrl}}`) o un literal `https://`; el valor de la variable se valida como http(s)
 * al renderizar.
 */

export const EMAIL_BLOCK_TYPES = [
  'heading',
  'paragraph',
  'button',
  'divider',
  'keyValueList',
  'callout',
  'spacer',
] as const;

export type EmailBlockType = (typeof EMAIL_BLOCK_TYPES)[number];

export const CALLOUT_TONES = ['info', 'warning'] as const;
export type CalloutTone = (typeof CALLOUT_TONES)[number];

export const SPACER_SIZES = ['sm', 'md', 'lg'] as const;
export type SpacerSize = (typeof SPACER_SIZES)[number];

export interface HeadingBlock {
  readonly type: 'heading';
  readonly text: string;
}

export interface ParagraphBlock {
  readonly type: 'paragraph';
  /** Los saltos de línea se conservan (<br> en HTML). */
  readonly text: string;
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

export type EmailBlock =
  | HeadingBlock
  | ParagraphBlock
  | ButtonBlock
  | DividerBlock
  | KeyValueListBlock
  | CalloutBlock
  | SpacerBlock;

export const EMAIL_DESIGN_LIMITS = {
  subjectMaxLength: 200,
  minBlocks: 1,
  maxBlocks: 40,
  headingMaxLength: 200,
  paragraphMaxLength: 2000,
  buttonLabelMaxLength: 60,
  urlMaxLength: 500,
  keyValueMinItems: 1,
  keyValueMaxItems: 20,
  keyValueLabelMaxLength: 80,
  keyValueValueMaxLength: 500,
  calloutMaxLength: 1000,
} as const;

/** Campo editable de un bloque, para que el frontend arme el formulario sin duplicar reglas. */
export interface EmailBlockFieldSpec {
  readonly name: string;
  readonly label: string;
  readonly kind: 'text' | 'multiline' | 'url' | 'enum' | 'items';
  readonly required: boolean;
  readonly maxLength: number | null;
  readonly allowsVariables: boolean;
  readonly options: ReadonlyArray<string> | null;
  /** Solo kind = items: mínimo y máximo de filas; cada fila tiene label y value. */
  readonly minItems: number | null;
  readonly maxItems: number | null;
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
    description: 'Texto corrido; los saltos de línea se conservan',
    fields: [
      field({ name: 'text', label: 'Texto', kind: 'multiline', maxLength: L.paragraphMaxLength, allowsVariables: true }),
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
];

export interface EmailDesignIssue {
  readonly field: string;
  readonly message: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const TOKEN_ONLY = /^\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}$/;

/** Literal https:// sin espacios ni variables, que el analizador de URL acepte tal cual. */
export const isHttpsLiteral = (value: string): boolean => {
  if (!value.startsWith('https://') || /\s|\{\{|\}\}/.test(value)) {
    return false;
  }
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};

/** Token si el URL del botón es exactamente una variable `{{token}}`; null si no. */
export const buttonUrlToken = (url: string): string | null => TOKEN_ONLY.exec(url.trim())?.[1] ?? null;

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
  if (typeof value === 'string' && value.trim() !== '' && buttonUrlToken(value) === null && !isHttpsLiteral(value)) {
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

const BLOCK_FIELDS: Record<EmailBlockType, Record<string, FieldCheck>> = {
  heading: { text: text(L.headingMaxLength) },
  paragraph: { text: text(L.paragraphMaxLength) },
  button: { label: text(L.buttonLabelMaxLength), url },
  divider: {},
  keyValueList: { items },
  callout: { tone: oneOf(CALLOUT_TONES), text: text(L.calloutMaxLength) },
  spacer: { size: oneOf(SPACER_SIZES) },
};

const isBlockType = (value: unknown): value is EmailBlockType =>
  typeof value === 'string' && (EMAIL_BLOCK_TYPES as ReadonlyArray<string>).includes(value);

/**
 * Validación estricta de la estructura (no de las variables: eso depende del tipo, ver email-template-catalog.ts).
 * Rechaza tipos desconocidos, campos de más o de menos, longitudes y número de bloques fuera de límite.
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
  return issues;
};

/** Textos del bloque donde pueden ir variables (incluye el URL del botón). */
export const blockTexts = (block: EmailBlock): ReadonlyArray<string> => {
  switch (block.type) {
    case 'heading':
    case 'paragraph':
    case 'callout':
      return [block.text];
    case 'button':
      return [block.label, block.url];
    case 'keyValueList':
      return block.items.flatMap((item) => [item.label, item.value]);
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
      case 'paragraph':
        return { type: block.type, text: block.text };
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
    }
  });
