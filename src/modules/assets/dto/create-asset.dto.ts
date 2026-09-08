import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import {
  PHYSICAL_CONDITIONS,
  PhysicalCondition,
} from '../enums/physical-condition.enum.js';

export class CreateAssetDto {
  @ApiPropertyOptional({ example: 'A2026-0001', maxLength: 30 })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  readonly internalCode?: string;

  @ApiProperty({ example: 'Portátil Dell Latitude 5540', maxLength: 500 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  readonly description!: string;

  @ApiPropertyOptional({ maxLength: 150 })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  readonly model?: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  readonly categoryId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  readonly costCenterId!: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  readonly locationId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  readonly responsibleId?: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  readonly acquisitionTypeId!: string;

  @ApiProperty({ example: '2026-03-15' })
  @IsDateString()
  readonly acquisitionDate!: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  readonly acquisitionDocument?: string;

  @ApiPropertyOptional({ example: 2500000 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  readonly acquisitionPrice?: number;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  readonly serialNumber?: string;

  @ApiPropertyOptional({ maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  readonly barcode?: string;

  @ApiPropertyOptional({ enum: PHYSICAL_CONDITIONS })
  @IsOptional()
  @IsIn(PHYSICAL_CONDITIONS)
  readonly physicalCondition?: PhysicalCondition;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  readonly notes?: string;

  @ApiPropertyOptional({ description: 'URL de la foto principal' })
  @IsOptional()
  @IsString()
  readonly photoUrl?: string;

  @ApiPropertyOptional({
    example: { ramGB: 16, procesador: 'Intel i7', sistemaOperativo: 'Windows' },
  })
  @IsOptional()
  @IsObject()
  readonly customValues?: Record<string, unknown>;
}
