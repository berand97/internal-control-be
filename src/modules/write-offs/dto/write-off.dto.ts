import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ApiSignerSubstitutions, type SignerSubstitutionsInput } from '../../documents/dto/signer-substitution.dto.js';
import {
  MAX_WRITE_OFF_ASSETS,
  MAX_WRITE_OFF_QUANTITY,
  WRITE_OFF_ITEM_STATES,
  WRITE_OFF_STATUSES,
  type WriteOffItemState,
  type WriteOffStatus,
} from '../domain/write-off.js';

export class WriteOffItemInputDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  readonly assetId!: string;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: MAX_WRITE_OFF_QUANTITY, default: 1, description: 'Columna Cantidad del acta' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_WRITE_OFF_QUANTITY)
  readonly quantity?: number;

  @ApiProperty({ enum: WRITE_OFF_ITEM_STATES, enumName: 'WriteOffItemState', description: 'Columna Estado del acta (GET /write-offs/item-states)' })
  @IsIn(WRITE_OFF_ITEM_STATES)
  readonly state!: WriteOffItemState;

  @ApiPropertyOptional({ description: 'Columna Observaciones del acta', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  readonly notes?: string;
}

class WriteOffFieldsDto {
  @ApiPropertyOptional({ type: 'number', minimum: 0, nullable: true, description: 'Total autorizado de la baja. Obligatorio para generar el acta' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9_999_999_999_999)
  readonly authorizedTotal?: number | null;

  @ApiPropertyOptional({ type: 'string', nullable: true, maxLength: 100, example: 'ACUERDO 030-2026', description: 'Acuerdo del Consejo Universitario que autoriza la baja' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  readonly councilAgreementNumber?: string | null;

  @ApiPropertyOptional({ type: 'string', format: 'date', nullable: true, example: '2026-07-28', description: 'Fecha del voto del Consejo Universitario' })
  @IsOptional()
  @IsDateString({ strict: true })
  readonly councilAgreementDate?: string | null;

  @ApiPropertyOptional({ type: 'string', nullable: true, maxLength: 200, example: 'IBV - 00015 y 00016', description: 'Informes de Vicefinanciera citados en el acta' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  readonly vicefinanceReports?: string | null;

  @ApiPropertyOptional({ type: 'string', nullable: true, maxLength: 2000, description: 'Nota del acta' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  readonly observations?: string | null;
}

export class CreateWriteOffDto extends WriteOffFieldsDto {
  @ApiProperty({
    type: [WriteOffItemInputDto],
    description: `Activos de la baja en el orden del acta (1 a ${MAX_WRITE_OFF_ASSETS}). Pueden ser de varios centros de costo`,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_WRITE_OFF_ASSETS)
  @ValidateNested({ each: true })
  @Type(() => WriteOffItemInputDto)
  readonly items!: WriteOffItemInputDto[];
}

export class UpdateWriteOffDto extends WriteOffFieldsDto {
  @ApiPropertyOptional({ type: [WriteOffItemInputDto], description: 'Lista completa de activos (reemplaza la anterior)' })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_WRITE_OFF_ASSETS)
  @ValidateNested({ each: true })
  @Type(() => WriteOffItemInputDto)
  readonly items?: WriteOffItemInputDto[];
}

export class GenerateWriteOffActDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Quién firma por Control Interno (GET /documents/control-signers). Opcional si hay una sola persona elegible',
  })
  @IsOptional()
  @IsUUID('all')
  readonly controlSignerPersonId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Quién firma por Contabilidad (GET /write-offs/accounting-signers). Opcional si hay una sola persona elegible',
  })
  @IsOptional()
  @IsUUID('all')
  readonly accountingSignerPersonId?: string;

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

  @ApiPropertyOptional({ format: 'uuid', description: 'Bajas con algún activo de este centro de costo' })
  @IsOptional()
  @IsUUID('all')
  readonly costCenterId?: string;
}
