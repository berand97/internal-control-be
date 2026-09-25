import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { DATA_QUALITY_FLAGS } from '../enums/data-quality-flag.enum.js';
import {
  OPERATIONAL_STATUSES,
  OperationalStatus,
} from '../enums/operational-status.enum.js';

const SORT_FIELDS = [
  'internalCode',
  'description',
  'acquisitionDate',
  'operationalStatus',
  'createdAt',
] as const;

export class QueryAssetsDto {
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

  @ApiPropertyOptional({ enum: SORT_FIELDS })
  @IsOptional()
  @IsIn(SORT_FIELDS)
  readonly sortBy?: (typeof SORT_FIELDS)[number];

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  readonly sortOrder: 'asc' | 'desc' = 'desc';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  readonly q?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  readonly categoryId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  readonly costCenterId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  readonly locationId?: string;

  @ApiPropertyOptional({ enum: OPERATIONAL_STATUSES })
  @IsOptional()
  @IsIn(OPERATIONAL_STATUSES)
  readonly operationalStatus?: OperationalStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  readonly acquiredFrom?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  readonly acquiredTo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (value === 'true') {
      return true;
    }
    if (value === 'false') {
      return false;
    }
    return value;
  })
  @IsBoolean()
  readonly hasBarcode?: boolean;

  @ApiPropertyOptional({
    enum: DATA_QUALITY_FLAGS,
    isArray: true,
    description: 'Activos que tienen todas las banderas indicadas. Repetir el parámetro o separar por comas.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    (Array.isArray(value) ? value : [value])
      .flatMap((item) => String(item).split(','))
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  )
  @IsIn(DATA_QUALITY_FLAGS, { each: true })
  readonly dataQualityFlags?: string[];
}
