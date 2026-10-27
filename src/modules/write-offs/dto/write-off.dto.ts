import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ApiSignerSubstitutions, type SignerSubstitutionsInput } from '../../documents/dto/signer-substitution.dto.js';
import {
  MAX_WRITE_OFF_ASSETS,
  WRITE_OFF_REASONS,
  WRITE_OFF_STATUSES,
  type WriteOffReason,
  type WriteOffStatus,
} from '../domain/write-off.js';

export class CreateWriteOffDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    description: `Activos de la baja en el orden del acta (1 a ${MAX_WRITE_OFF_ASSETS}), todos del mismo centro de costo`,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_WRITE_OFF_ASSETS)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  readonly assetIds!: string[];

  @ApiProperty({ enum: WRITE_OFF_REASONS, enumName: 'WriteOffReason', description: 'Motivo de la baja (GET /write-offs/reasons)' })
  @IsIn(WRITE_OFF_REASONS)
  readonly reason!: WriteOffReason;

  @ApiPropertyOptional({ description: 'Detalle del motivo. Obligatorio con OTHER', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  readonly reasonDetail?: string;

  @ApiProperty({ description: 'Concepto técnico o estado físico de los bienes', minLength: 3, maxLength: 2000 })
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  readonly technicalConcept!: string;

  @ApiProperty({ description: 'Disposición final de los bienes', minLength: 3, maxLength: 1000 })
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  readonly finalDisposition!: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  readonly observations?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Quien firma como Responsable. Por defecto, el jefe vigente del centro de costo de los activos',
  })
  @IsOptional()
  @IsUUID('all')
  readonly responsiblePersonId?: string;
}

export class UpdateWriteOffDto {
  @ApiPropertyOptional({ type: [String], format: 'uuid', description: 'Lista completa de activos (reemplaza la anterior)' })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_WRITE_OFF_ASSETS)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  readonly assetIds?: string[];

  @ApiPropertyOptional({ enum: WRITE_OFF_REASONS, enumName: 'WriteOffReason' })
  @IsOptional()
  @IsIn(WRITE_OFF_REASONS)
  readonly reason?: WriteOffReason;

  @ApiPropertyOptional({ type: 'string', nullable: true, maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  readonly reasonDetail?: string | null;

  @ApiPropertyOptional({ minLength: 3, maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  readonly technicalConcept?: string;

  @ApiPropertyOptional({ minLength: 3, maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  readonly finalDisposition?: string;

  @ApiPropertyOptional({ type: 'string', nullable: true, maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  readonly observations?: string | null;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all')
  readonly responsiblePersonId?: string;
}

export class GenerateWriteOffActDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Quién firma por Control Interno (GET /documents/control-signers). Opcional si hay una sola persona elegible, obligatorio si hay varias',
  })
  @IsOptional()
  @IsUUID('all')
  readonly controlSignerPersonId?: string;

  @ApiSignerSubstitutions()
  readonly signerSubstitutions?: SignerSubstitutionsInput;
}

export class CancelWriteOffDto {
  @ApiProperty({ description: 'Motivo de la cancelación', minLength: 5, maxLength: 500 })
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  readonly reason!: string;
}

export class QueryWriteOffsDto {
  @ApiPropertyOptional({ type: 'integer', minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  readonly page: number = 1;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  readonly pageSize: number = 20;

  @ApiPropertyOptional({ enum: WRITE_OFF_STATUSES, enumName: 'WriteOffStatus' })
  @IsOptional()
  @IsIn(WRITE_OFF_STATUSES)
  readonly status?: WriteOffStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all')
  readonly costCenterId?: string;
}
