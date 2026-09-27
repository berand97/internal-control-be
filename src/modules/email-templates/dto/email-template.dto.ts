import { ApiProperty, ApiPropertyOptional, getSchemaPath } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import {
  CALLOUT_TONES,
  EMAIL_BLOCK_TYPES,
  EMAIL_DESIGN_LIMITS,
  IMAGE_ALIGNS,
  SPACER_SIZES,
  type EmailBlock,
} from '../domain/email-blocks.js';
import { RICH_TEXT_LIMITS } from '../domain/rich-text.js';
import {
  EMAIL_TEMPLATE_TYPES,
  type EmailTemplateType,
} from '../domain/email-template-catalog.js';

const L = EMAIL_DESIGN_LIMITS;

// ---------- Bloques (esquemas OpenAPI; la validación estricta es validateEmailBlocks) ----------

export class HeadingBlockDto {
  @ApiProperty({ enum: ['heading'], enumName: 'EmailHeadingBlockType' })
  readonly type!: 'heading';

  @ApiProperty({ maxLength: L.headingMaxLength, description: 'Admite variables {{...}}' })
  readonly text!: string;
}

// ---------- Texto enriquecido del párrafo (esquema cerrado; ver domain/rich-text.ts) ----------

const HREF_DESCRIPTION =
  'Exactamente una variable del catálogo ({{app.loginUrl}}) o un literal https://. Sin target, rel ni class: el frontend los quita antes de enviar';

export class EmailRichTextBoldMarkDto {
  @ApiProperty({ enum: ['bold'], enumName: 'EmailRichTextBoldMarkType' })
  readonly type!: 'bold';
}

export class EmailRichTextItalicMarkDto {
  @ApiProperty({ enum: ['italic'], enumName: 'EmailRichTextItalicMarkType' })
  readonly type!: 'italic';
}

export class EmailRichTextUnderlineMarkDto {
  @ApiProperty({ enum: ['underline'], enumName: 'EmailRichTextUnderlineMarkType' })
  readonly type!: 'underline';
}

export class EmailRichTextLinkAttrsDto {
  @ApiProperty({ maxLength: RICH_TEXT_LIMITS.hrefMaxLength, description: HREF_DESCRIPTION })
  readonly href!: string;
}

export class EmailRichTextLinkMarkDto {
  @ApiProperty({ enum: ['link'], enumName: 'EmailRichTextLinkMarkType' })
  readonly type!: 'link';

  @ApiProperty({ type: EmailRichTextLinkAttrsDto })
  readonly attrs!: EmailRichTextLinkAttrsDto;
}

const MARK_DTOS = [
  EmailRichTextBoldMarkDto,
  EmailRichTextItalicMarkDto,
  EmailRichTextUnderlineMarkDto,
  EmailRichTextLinkMarkDto,
] as const;

const marksSchema = (description: string): SchemaObject => ({
  type: 'array',
  items: { oneOf: MARK_DTOS.map((dto) => ({ $ref: getSchemaPath(dto) })) },
  description,
});

export class EmailRichTextTextDto {
  @ApiProperty({ enum: ['text'], enumName: 'EmailRichTextTextType' })
  readonly type!: 'text';

  @ApiProperty({
    minLength: 1,
    description: 'Texto sin marcado; admite variables {{...}} completas (no partidas por un formato ni un salto)',
  })
  readonly text!: string;

  @ApiPropertyOptional(marksSchema('Cada marca a lo sumo una vez') as never)
  readonly marks?: ReadonlyArray<unknown>;
}

export class EmailRichTextHardBreakDto {
  @ApiProperty({ enum: ['hardBreak'], enumName: 'EmailRichTextHardBreakType' })
  readonly type!: 'hardBreak';

  @ApiPropertyOptional(marksSchema('Se aceptan y se ignoran (no se guardan)') as never)
  readonly marks?: ReadonlyArray<unknown>;
}

export class EmailRichTextParagraphDto {
  @ApiProperty({ enum: ['paragraph'], enumName: 'EmailRichTextParagraphType' })
  readonly type!: 'paragraph';

  @ApiPropertyOptional({
    type: 'array',
    items: {
      oneOf: [{ $ref: getSchemaPath(EmailRichTextTextDto) }, { $ref: getSchemaPath(EmailRichTextHardBreakDto) }],
    },
    description: 'Sin content = línea en blanco. Sin attrs (textAlign no se admite)',
  } as never)
  readonly content?: ReadonlyArray<unknown>;
}

export class EmailRichTextListItemDto {
  @ApiProperty({ enum: ['listItem'], enumName: 'EmailRichTextListItemType' })
  readonly type!: 'listItem';

  @ApiProperty({
    type: [EmailRichTextParagraphDto],
    minItems: 1,
    description: 'Solo párrafos: no se admiten listas anidadas',
  })
  readonly content!: ReadonlyArray<EmailRichTextParagraphDto>;
}

export class EmailRichTextBulletListDto {
  @ApiProperty({ enum: ['bulletList'], enumName: 'EmailRichTextBulletListType' })
  readonly type!: 'bulletList';

  @ApiProperty({ type: [EmailRichTextListItemDto], minItems: 1 })
  readonly content!: ReadonlyArray<EmailRichTextListItemDto>;
}

export class EmailRichTextOrderedListDto {
  @ApiProperty({ enum: ['orderedList'], enumName: 'EmailRichTextOrderedListType' })
  readonly type!: 'orderedList';

  @ApiProperty({
    type: [EmailRichTextListItemDto],
    minItems: 1,
    description: 'Siempre empieza en 1: sin attrs (start, type)',
  })
  readonly content!: ReadonlyArray<EmailRichTextListItemDto>;
}

export class EmailRichTextDocDto {
  @ApiProperty({ enum: ['doc'], enumName: 'EmailRichTextDocType' })
  readonly type!: 'doc';

  @ApiProperty({
    type: 'array',
    minItems: 1,
    items: {
      oneOf: [
        { $ref: getSchemaPath(EmailRichTextParagraphDto) },
        { $ref: getSchemaPath(EmailRichTextBulletListDto) },
        { $ref: getSchemaPath(EmailRichTextOrderedListDto) },
      ],
    },
    description: `Máximo ${RICH_TEXT_LIMITS.maxTextLength} caracteres de texto y ${RICH_TEXT_LIMITS.maxNodes} nodos en total`,
  } as never)
  readonly content!: ReadonlyArray<unknown>;
}

export const EMAIL_RICH_TEXT_DTOS = [
  ...MARK_DTOS,
  EmailRichTextLinkAttrsDto,
  EmailRichTextTextDto,
  EmailRichTextHardBreakDto,
  EmailRichTextParagraphDto,
  EmailRichTextListItemDto,
  EmailRichTextBulletListDto,
  EmailRichTextOrderedListDto,
  EmailRichTextDocDto,
] as const;

export class ParagraphBlockDto {
  @ApiProperty({ enum: ['paragraph'], enumName: 'EmailParagraphBlockType' })
  readonly type!: 'paragraph';

  @ApiProperty({
    type: EmailRichTextDocDto,
    description: 'Documento Tiptap/ProseMirror (editor.getJSON()) de esquema cerrado; nunca HTML',
  })
  readonly content!: EmailRichTextDocDto;
}

export class ButtonBlockDto {
  @ApiProperty({ enum: ['button'], enumName: 'EmailButtonBlockType' })
  readonly type!: 'button';

  @ApiProperty({ maxLength: L.buttonLabelMaxLength, description: 'Admite variables {{...}}' })
  readonly label!: string;

  @ApiProperty({
    maxLength: L.urlMaxLength,
    description: 'Exactamente una variable del catálogo ({{auth.resetUrl}}) o un literal https://',
  })
  readonly url!: string;
}

export class DividerBlockDto {
  @ApiProperty({ enum: ['divider'], enumName: 'EmailDividerBlockType' })
  readonly type!: 'divider';
}

export class KeyValueItemDto {
  @ApiProperty({ maxLength: L.keyValueLabelMaxLength, description: 'Admite variables {{...}}' })
  readonly label!: string;

  @ApiProperty({ maxLength: L.keyValueValueMaxLength, description: 'Admite variables {{...}}' })
  readonly value!: string;
}

export class KeyValueListBlockDto {
  @ApiProperty({ enum: ['keyValueList'], enumName: 'EmailKeyValueListBlockType' })
  readonly type!: 'keyValueList';

  @ApiProperty({ type: [KeyValueItemDto], minItems: L.keyValueMinItems, maxItems: L.keyValueMaxItems })
  readonly items!: ReadonlyArray<KeyValueItemDto>;
}

export class CalloutBlockDto {
  @ApiProperty({ enum: ['callout'], enumName: 'EmailCalloutBlockType' })
  readonly type!: 'callout';

  @ApiProperty({ enum: CALLOUT_TONES, enumName: 'EmailCalloutTone' })
  readonly tone!: (typeof CALLOUT_TONES)[number];

  @ApiProperty({ maxLength: L.calloutMaxLength, description: 'Admite variables {{...}} y saltos de línea' })
  readonly text!: string;
}

export class SpacerBlockDto {
  @ApiProperty({ enum: ['spacer'], enumName: 'EmailSpacerBlockType' })
  readonly type!: 'spacer';

  @ApiProperty({ enum: SPACER_SIZES, enumName: 'EmailSpacerSize' })
  readonly size!: (typeof SPACER_SIZES)[number];
}

export class ImageBlockDto {
  @ApiProperty({ enum: ['image'], enumName: 'EmailImageBlockType' })
  readonly type!: 'image';

  @ApiProperty({ format: 'uuid', description: 'id de una imagen subida (POST /email-templates/assets); debe existir' })
  readonly assetId!: string;

  @ApiProperty({
    maxLength: L.imageAltMaxLength,
    description: 'Texto alternativo (obligatorio); admite variables {{...}}',
  })
  readonly alt!: string;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: L.imageMinWidth,
    maximum: L.imageMaxWidth,
    description: `Ancho en px. Sin él: el ancho natural de la imagen, limitado a ${L.imageMaxWidth}`,
  })
  readonly width?: number;

  @ApiProperty({ enum: IMAGE_ALIGNS, enumName: 'EmailImageAlign' })
  readonly align!: (typeof IMAGE_ALIGNS)[number];

  @ApiPropertyOptional({
    maxLength: L.urlMaxLength,
    description: 'Enlace opcional: exactamente una variable del catálogo o un literal https://',
  })
  readonly href?: string;
}

export const EMAIL_BLOCK_DTOS = [
  HeadingBlockDto,
  ParagraphBlockDto,
  ButtonBlockDto,
  DividerBlockDto,
  KeyValueListBlockDto,
  CalloutBlockDto,
  SpacerBlockDto,
  ImageBlockDto,
] as const;

const BLOCK_DTO_BY_TYPE = {
  heading: HeadingBlockDto,
  paragraph: ParagraphBlockDto,
  button: ButtonBlockDto,
  divider: DividerBlockDto,
  keyValueList: KeyValueListBlockDto,
  callout: CalloutBlockDto,
  spacer: SpacerBlockDto,
  image: ImageBlockDto,
} as const;

/** Arreglo de bloques como oneOf con discriminador `type`. */
export const emailBlocksSchema = (extra: SchemaObject = {}): SchemaObject => ({
  type: 'array',
  items: {
    oneOf: EMAIL_BLOCK_DTOS.map((dto) => ({ $ref: getSchemaPath(dto) })),
    discriminator: {
      propertyName: 'type',
      mapping: Object.fromEntries(
        Object.entries(BLOCK_DTO_BY_TYPE).map(([type, dto]) => [type, getSchemaPath(dto)]),
      ),
    },
  },
  ...extra,
});

// ---------- Solicitudes ----------

export class ListEmailTemplatesQueryDto {
  @ApiProperty({ enum: EMAIL_TEMPLATE_TYPES, enumName: 'EmailTemplateType' })
  @IsIn(EMAIL_TEMPLATE_TYPES)
  readonly templateType!: EmailTemplateType;
}

export class EmailTemplateDesignDto {
  @ApiProperty({ enum: EMAIL_TEMPLATE_TYPES, enumName: 'EmailTemplateType' })
  @IsIn(EMAIL_TEMPLATE_TYPES)
  readonly templateType!: EmailTemplateType;

  @ApiProperty({ maxLength: L.subjectMaxLength, description: 'Admite variables {{...}}' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(L.subjectMaxLength)
  readonly subject!: string;

  @ApiProperty(
    emailBlocksSchema({
      minItems: L.minBlocks,
      maxItems: L.maxBlocks,
      description: `Entre ${L.minBlocks} y ${L.maxBlocks} bloques del catálogo cerrado (${EMAIL_BLOCK_TYPES.join(', ')})`,
    }) as never,
  )
  @IsArray()
  @ArrayMinSize(L.minBlocks)
  @ArrayMaxSize(L.maxBlocks)
  readonly blocks!: ReadonlyArray<EmailBlock>;
}

/** POST /email-templates: guarda una versión nueva (queda activa). */
export class CreateEmailTemplateVersionDto extends EmailTemplateDesignDto {}

/** POST /email-templates/preview: renderiza un borrador con datos de ejemplo, sin guardar ni enviar. */
export class PreviewEmailTemplateDto extends EmailTemplateDesignDto {}

export class SendTestEmailDto {
  @ApiProperty({ enum: EMAIL_TEMPLATE_TYPES, enumName: 'EmailTemplateType' })
  @IsIn(EMAIL_TEMPLATE_TYPES)
  readonly templateType!: EmailTemplateType;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Versión a enviar (del mismo tipo). Sin ella se envía la versión activa (o el diseño por defecto)',
  })
  @IsOptional()
  @IsUUID('4')
  readonly templateId?: string;
}
