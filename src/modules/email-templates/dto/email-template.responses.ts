import { ApiProperty, getSchemaPath } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger';
import { ApiSuccessEnvelope } from '../../../common/swagger/api-envelopes.js';
import {
  CALLOUT_TONES,
  EMAIL_BLOCK_TYPES,
  SPACER_SIZES,
  type EmailBlock,
  type EmailBlockFieldSpec,
  type EmailBlockSpec,
} from '../domain/email-blocks.js';
import { EMAIL_TEMPLATE_TYPES, type EmailTemplateType } from '../domain/email-template-catalog.js';
import type { EmailTemplate } from '../entities/email-template.entity.js';
import { MAIL_OUTBOX_STATUSES, type MailOutboxStatus } from '../../../shared/mail/mail-outbox-status.js';
import { emailBlocksSchema } from './email-template.dto.js';

// ---------- GET /email-templates/catalog ----------

export const EMAIL_BLOCK_FIELD_KINDS = ['text', 'multiline', 'url', 'enum', 'items'] as const;

export class EmailBlockFieldSpecDto {
  @ApiProperty({ description: 'Nombre de la propiedad en el bloque' })
  readonly name!: string;

  @ApiProperty()
  readonly label!: string;

  @ApiProperty({
    enum: EMAIL_BLOCK_FIELD_KINDS,
    enumName: 'EmailBlockFieldKind',
    description: 'items: lista de filas { label, value }',
  })
  readonly kind!: EmailBlockFieldSpec['kind'];

  @ApiProperty()
  readonly required!: boolean;

  @ApiProperty({ type: 'integer', nullable: true, description: 'Para items: largo máximo de cada valor' })
  readonly maxLength!: number | null;

  @ApiProperty()
  readonly allowsVariables!: boolean;

  @ApiProperty({ type: [String], nullable: true, description: 'Solo kind = enum' })
  readonly options!: ReadonlyArray<string> | null;

  @ApiProperty({ type: 'integer', nullable: true, description: 'Solo kind = items' })
  readonly minItems!: number | null;

  @ApiProperty({ type: 'integer', nullable: true, description: 'Solo kind = items' })
  readonly maxItems!: number | null;
}

export class EmailBlockSpecDto {
  @ApiProperty({ enum: EMAIL_BLOCK_TYPES, enumName: 'EmailBlockType' })
  readonly type!: EmailBlockSpec['type'];

  @ApiProperty()
  readonly label!: string;

  @ApiProperty()
  readonly description!: string;

  @ApiProperty({ type: [EmailBlockFieldSpecDto] })
  readonly fields!: ReadonlyArray<EmailBlockFieldSpecDto>;
}

export class EmailDesignLimitsDto {
  @ApiProperty({ type: 'integer' }) readonly subjectMaxLength!: number;
  @ApiProperty({ type: 'integer' }) readonly minBlocks!: number;
  @ApiProperty({ type: 'integer' }) readonly maxBlocks!: number;
  @ApiProperty({ type: 'integer' }) readonly headingMaxLength!: number;
  @ApiProperty({ type: 'integer' }) readonly paragraphMaxLength!: number;
  @ApiProperty({ type: 'integer' }) readonly buttonLabelMaxLength!: number;
  @ApiProperty({ type: 'integer' }) readonly urlMaxLength!: number;
  @ApiProperty({ type: 'integer' }) readonly keyValueMinItems!: number;
  @ApiProperty({ type: 'integer' }) readonly keyValueMaxItems!: number;
  @ApiProperty({ type: 'integer' }) readonly keyValueLabelMaxLength!: number;
  @ApiProperty({ type: 'integer' }) readonly keyValueValueMaxLength!: number;
  @ApiProperty({ type: 'integer' }) readonly calloutMaxLength!: number;
}

export class EmailTemplateTypeDto {
  @ApiProperty({ enum: EMAIL_TEMPLATE_TYPES, enumName: 'EmailTemplateType' })
  readonly templateType!: EmailTemplateType;

  @ApiProperty()
  readonly label!: string;

  @ApiProperty({ type: [String], description: 'Variables que el diseño debe usar al menos una vez' })
  readonly required!: ReadonlyArray<string>;

  @ApiProperty({ type: [String] })
  readonly optional!: ReadonlyArray<string>;

  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' }, description: 'Datos de ejemplo de la vista previa' })
  readonly sampleContext!: Record<string, string>;

  @ApiProperty()
  readonly defaultSubject!: string;

  @ApiProperty(emailBlocksSchema({ description: 'Diseño por defecto (se usa mientras no haya versión activa)' }) as never)
  readonly defaultBlocks!: ReadonlyArray<EmailBlock>;

  @ApiProperty({ type: 'integer', nullable: true, description: 'Versión activa; null si se usa el diseño por defecto' })
  readonly activeVersion!: number | null;
}

export class EmailTemplateCatalogResponseDto {
  @ApiProperty({ type: [EmailTemplateTypeDto] })
  readonly types!: ReadonlyArray<EmailTemplateTypeDto>;

  @ApiProperty({ type: [EmailBlockSpecDto] })
  readonly blocks!: ReadonlyArray<EmailBlockSpecDto>;

  @ApiProperty({ type: EmailDesignLimitsDto })
  readonly limits!: EmailDesignLimitsDto;

  @ApiProperty({ enum: CALLOUT_TONES, enumName: 'EmailCalloutTone', isArray: true })
  readonly calloutTones!: ReadonlyArray<string>;

  @ApiProperty({ enum: SPACER_SIZES, enumName: 'EmailSpacerSize', isArray: true })
  readonly spacerSizes!: ReadonlyArray<string>;
}

// ---------- Versiones ----------

export class EmailTemplateVersionResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ enum: EMAIL_TEMPLATE_TYPES, enumName: 'EmailTemplateType' })
  readonly templateType!: EmailTemplateType;

  @ApiProperty({ type: 'integer' })
  readonly version!: number;

  @ApiProperty()
  readonly subject!: string;

  @ApiProperty(emailBlocksSchema() as never)
  readonly blocks!: ReadonlyArray<EmailBlock>;

  @ApiProperty({ type: [String], description: 'Variables usadas por el diseño' })
  readonly placeholders!: ReadonlyArray<string>;

  @ApiProperty()
  readonly isActive!: boolean;

  @ApiProperty({ type: 'string', format: 'date-time' })
  readonly createdAt!: string;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, description: 'null en las versiones sembradas por migración' })
  readonly createdBy!: string | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly activatedAt!: string | null;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true })
  readonly activatedBy!: string | null;

  static from(row: EmailTemplate): EmailTemplateVersionResponseDto {
    return {
      id: row.id,
      templateType: row.templateType,
      version: row.version,
      subject: row.subject,
      blocks: row.blocks,
      placeholders: row.placeholders,
      isActive: row.isActive,
      createdAt: new Date(row.createdAt).toISOString(),
      createdBy: row.createdBy,
      activatedAt: row.activatedAt ? new Date(row.activatedAt).toISOString() : null,
      activatedBy: row.activatedBy,
    };
  }
}

// ---------- Vista previa y prueba ----------

export class EmailPreviewResponseDto {
  @ApiProperty({ description: 'Asunto renderizado con los datos de ejemplo' })
  readonly subject!: string;

  @ApiProperty({ description: 'Documento HTML completo (layout institucional + bloques), para un iframe sandbox' })
  readonly html!: string;

  @ApiProperty({ description: 'Versión en texto plano (la parte text/plain del correo)' })
  readonly text!: string;
}

export class EmailTestSendResponseDto {
  @ApiProperty({ format: 'uuid', description: 'Fila del outbox de correo' })
  readonly outboxId!: string;

  @ApiProperty({ enum: MAIL_OUTBOX_STATUSES, enumName: 'MailOutboxStatus' })
  readonly status!: MailOutboxStatus;

  @ApiProperty({ type: 'string', nullable: true, description: 'Motivo si quedó FAILED (p. ej. SMTP sin configurar)' })
  readonly lastError!: string | null;

  @ApiProperty({ type: 'string', nullable: true, description: 'Correo del usuario actual; null si no tiene' })
  readonly to!: string | null;

  @ApiProperty({ format: 'uuid', nullable: true, type: 'string', description: 'Versión enviada; null si fue el diseño por defecto' })
  readonly templateId!: string | null;
}

/** `data` del envelope como arreglo de `dto` (envelopedSchema solo describe un objeto). */
export const envelopedArraySchema = (dto: Function): SchemaObject => ({
  allOf: [
    { $ref: getSchemaPath(ApiSuccessEnvelope) },
    { properties: { data: { type: 'array', items: { $ref: getSchemaPath(dto) } } } },
  ],
});
