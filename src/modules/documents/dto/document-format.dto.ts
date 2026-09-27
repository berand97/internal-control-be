import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  SGC_VERSION_PATTERN,
  SIGNER_SOURCE_VALUES,
  type SignerSource,
} from '../domain/document-formats.js';

/** Entrada de la administración de formatos. DocumentFormatCatalogService vuelve a validar las reglas cruzadas. */

export class DocumentFormatSignerInputDto {
  @ApiProperty({
    type: 'integer',
    minimum: 1,
    maximum: 99,
    description: 'Turno de firma; únicos dentro de la versión',
  })
  @IsInt()
  @Min(1)
  @Max(99)
  readonly order!: number;

  @ApiProperty({
    example: 'RECIBE',
    description:
      'Mayúsculas, dígitos o guion bajo. La plantilla lo usa en minúsculas: {{firmante.recibe.nombre}}. AUDITA y CONTROL_INTERNO son turnos de Control Interno: firman siempre con sesión y MFA',
  })
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]{0,39}$/)
  readonly role!: string;

  @ApiProperty({
    example: 'Recibe',
    description:
      'Etiqueta del turno en el acta, el sobre, la hoja de firmas y la verificación pública',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  readonly label!: string;

  @ApiProperty({
    enum: SIGNER_SOURCE_VALUES,
    enumName: 'DocumentSignerSource',
    description:
      'RESPONSIBLE: la persona es responsiblePersonId de la solicitud (en un proceso, la pone el proceso); REQUEST: se pasa al generar en signers[ROL]',
  })
  @IsIn(SIGNER_SOURCE_VALUES)
  readonly source!: SignerSource;
}

export class DocumentFormatNumberingInputDto {
  @ApiProperty({
    type: 'integer',
    minimum: 1,
    maximum: 10,
    example: 4,
    description: 'Dígitos del consecutivo',
  })
  @IsInt()
  @Min(1)
  @Max(10)
  readonly width!: number;

  @ApiProperty({
    description:
      'true: reinicia cada año y se imprime AAAA-NNNN; false: continuo',
  })
  @IsBoolean()
  readonly perYear!: boolean;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    example: 0,
    description:
      'Último número emitido antes del sistema: el consecutivo arranca en el siguiente. Solo aplica mientras el consecutivo de ese periodo no ha empezado (si no, 409 DOCUMENT_FORMAT_SEQUENCE_STARTED)',
  })
  @IsInt()
  @Min(0)
  readonly lastIssued!: number;

  @ApiPropertyOptional({
    type: 'string',
    nullable: true,
    example: '2026',
    description:
      'Año de lastIssued; solo con perYear, y obligatorio si lastIssued > 0',
  })
  @IsOptional()
  @Matches(/^\d{4}$/)
  readonly lastIssuedPeriod?: string | null;
}

export class DocumentFormatVersionInputDto {
  @ApiProperty({
    example: 'OCI-01-65',
    description: 'Código SGC institucional (1 a 20 caracteres)',
  })
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/)
  readonly sgcCode!: string;

  @ApiProperty({
    example: '2',
    description: 'Versión SGC: 1 a 10 letras, dígitos, punto, guion o guion bajo; sin "/" ni ".."',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(10)
  @Matches(SGC_VERSION_PATTERN, {
    message: 'sgcVersion admite de 1 a 10 letras, dígitos, punto, guion o guion bajo, sin "/" ni ".."',
  })
  readonly sgcVersion!: string;

  @ApiProperty({ example: 'Acta de préstamo temporal de activos fijos' })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  readonly name!: string;

  @ApiPropertyOptional({
    type: 'string',
    format: 'date',
    description:
      'Desde cuándo rige (medianoche de Bogotá). Por defecto hoy. Versión nueva: hoy o después, y no antes de la última. Primera versión de un formato nuevo: hoy o antes',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  readonly effectiveFrom?: string;

  @ApiProperty({
    type: [DocumentFormatSignerInputDto],
    description: 'De 1 a 20 firmantes; orden y rol únicos',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => DocumentFormatSignerInputDto)
  readonly signers!: DocumentFormatSignerInputDto[];

  @ApiProperty({ type: () => DocumentFormatNumberingInputDto })
  @ValidateNested()
  @Type(() => DocumentFormatNumberingInputDto)
  readonly numbering!: DocumentFormatNumberingInputDto;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Decisiones que Control Interno aún debe tomar sobre el formato',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  readonly pendingDecisions?: string[];

  @ApiPropertyOptional({
    type: 'string',
    nullable: true,
    description: 'Por qué se crea esta versión (queda en el historial)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  readonly changeReason?: string | null;
}

export class CreateDocumentFormatDto extends DocumentFormatVersionInputDto {
  @ApiProperty({
    example: 'OCI-99-01',
    description:
      'Clave interna estable (mayúsculas, dígitos, guion, guion bajo; 2 a 40). No cambia nunca: la usan el consecutivo y las actas',
  })
  @IsString()
  @Matches(/^[A-Z0-9][A-Z0-9_-]{1,39}$/)
  readonly key!: string;

  @ApiProperty({
    example: 'asset:read:global',
    description: 'Permiso existente para ver sus actas',
  })
  @IsString()
  @MaxLength(100)
  readonly readPermission!: string;

  @ApiProperty({
    example: 'asset:update:global',
    description:
      'Permiso existente para generarlas, reasignar turnos y reenviar enlaces',
  })
  @IsString()
  @MaxLength(100)
  readonly generatePermission!: string;
}
