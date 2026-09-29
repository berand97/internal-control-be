import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const trimmed = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreatePriceZeroReasonDto {
  @ApiProperty({ minLength: 3, maxLength: 120, example: 'Donación sin avalúo' })
  @IsString()
  @Transform(trimmed)
  @MinLength(3)
  @MaxLength(120)
  readonly label!: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  readonly isActive?: boolean;

  @ApiPropertyOptional({ type: 'integer', minimum: 0, maximum: 9999, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(9999)
  readonly sortOrder?: number;
}

export class UpdatePriceZeroReasonDto extends PartialType(CreatePriceZeroReasonDto) {}

export class QueryPriceZeroAssetsDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  readonly page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  readonly pageSize: number = 20;

  @ApiPropertyOptional({ format: 'uuid', description: 'Centro de costo actual del activo' })
  @IsOptional()
  @IsUUID('all')
  readonly costCenterId?: string;

  @ApiPropertyOptional({ description: 'true: con motivo registrado; false: sin motivo' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  readonly classified?: boolean;

  @ApiPropertyOptional({ format: 'uuid', description: 'Solo los clasificados con este motivo' })
  @IsOptional()
  @IsUUID('all')
  readonly reasonId?: string;

  @ApiPropertyOptional({ maxLength: 100, description: 'Busca en el código interno y la descripción' })
  @IsOptional()
  @IsString()
  @Transform(trimmed)
  @MaxLength(100)
  readonly q?: string;
}

export class SetPriceZeroReasonDto {
  @ApiProperty({ format: 'uuid', description: 'Motivo activo del catálogo (GET /assets/price-zero-reasons)' })
  @IsUUID('all')
  readonly reasonId!: string;

  @ApiPropertyOptional({ minLength: 3, maxLength: 500, description: 'Observación. Sin ella se borra la anterior' })
  @IsOptional()
  @IsString()
  @Transform(trimmed)
  @MinLength(3)
  @MaxLength(500)
  readonly note?: string;
}
