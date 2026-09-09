import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  EMAIL_TEMPLATE_TYPES,
  type EmailTemplateType,
} from '../domain/email-template-catalog.js';
import type { EmailTemplate } from '../entities/email-template.entity.js';

export class SaveEmailTemplateDto {
  @ApiProperty({ enum: EMAIL_TEMPLATE_TYPES })
  @IsIn(EMAIL_TEMPLATE_TYPES)
  readonly templateType!: EmailTemplateType;

  @ApiProperty({ maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  readonly subject!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  readonly body!: string;
}

export class EmailTemplateCatalogItemDto {
  @ApiProperty()
  readonly templateType!: string;

  @ApiProperty()
  readonly label!: string;

  @ApiProperty({ type: [String] })
  readonly required!: ReadonlyArray<string>;

  @ApiProperty({ type: [String] })
  readonly optional!: ReadonlyArray<string>;

  @ApiProperty()
  readonly defaultSubject!: string;

  @ApiProperty()
  readonly defaultBody!: string;

  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  readonly sampleContext!: Record<string, string>;
}

export class EmailTemplateResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty()
  readonly templateType!: string;

  @ApiProperty()
  readonly version!: number;

  @ApiProperty()
  readonly subject!: string;

  @ApiProperty()
  readonly body!: string;

  @ApiProperty({ type: [String] })
  readonly placeholders!: ReadonlyArray<string>;

  @ApiProperty()
  readonly isActive!: boolean;

  static from(row: EmailTemplate): EmailTemplateResponseDto {
    return {
      id: row.id,
      templateType: row.templateType,
      version: row.version,
      subject: row.subject,
      body: row.body,
      placeholders: row.placeholders,
      isActive: row.isActive,
    };
  }
}

export class EmailPreviewDto {
  @ApiProperty({ enum: EMAIL_TEMPLATE_TYPES })
  @IsIn(EMAIL_TEMPLATE_TYPES)
  readonly templateType!: EmailTemplateType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  readonly subject?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  readonly body?: string;
}

export class EmailPreviewResponseDto {
  @ApiProperty()
  readonly subject!: string;

  @ApiProperty()
  readonly body!: string;
}
