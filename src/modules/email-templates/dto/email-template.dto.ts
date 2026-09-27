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
  SPACER_SIZES,
  type EmailBlock,
} from '../domain/email-blocks.js';
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

export class ParagraphBlockDto {
  @ApiProperty({ enum: ['paragraph'], enumName: 'EmailParagraphBlockType' })
  readonly type!: 'paragraph';

  @ApiProperty({ maxLength: L.paragraphMaxLength, description: 'Admite variables {{...}} y saltos de línea' })
  readonly text!: string;
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

export const EMAIL_BLOCK_DTOS = [
  HeadingBlockDto,
  ParagraphBlockDto,
  ButtonBlockDto,
  DividerBlockDto,
  KeyValueListBlockDto,
  CalloutBlockDto,
  SpacerBlockDto,
] as const;

const BLOCK_DTO_BY_TYPE = {
  heading: HeadingBlockDto,
  paragraph: ParagraphBlockDto,
  button: ButtonBlockDto,
  divider: DividerBlockDto,
  keyValueList: KeyValueListBlockDto,
  callout: CalloutBlockDto,
  spacer: SpacerBlockDto,
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
