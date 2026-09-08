import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PhysicalCondition } from '../../assets/enums/physical-condition.enum.js';
import { InventoryScopeType } from '../enums/inventory-scope.js';
import { InventoryStatus } from '../enums/inventory-status.js';

export class CreateInventoryDto {
  @ApiProperty({ example: 'Toma física Talento Humano 2026' })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  readonly name!: string;

  @ApiProperty({ enum: InventoryScopeType })
  @IsEnum(InventoryScopeType)
  readonly scope!: InventoryScopeType;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  readonly scopeId?: string;

  @ApiProperty()
  @IsDateString()
  readonly plannedStartDate!: string;

  @ApiProperty()
  @IsDateString()
  readonly plannedEndDate!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  readonly responsibleUserId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  readonly notes?: string;
}

export class VerifyInventoryAssetDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  readonly assetId!: string;

  @ApiProperty({ enum: PhysicalCondition })
  @IsEnum(PhysicalCondition)
  readonly condition!: PhysicalCondition;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  readonly locationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  readonly notes?: string;
}

export class ReportNotFoundDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  readonly assetId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  readonly notes?: string;
}

export class ReportUnexpectedDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  readonly assetId?: string;

  @ApiPropertyOptional({ enum: PhysicalCondition })
  @IsOptional()
  @IsEnum(PhysicalCondition)
  readonly condition?: PhysicalCondition;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  readonly locationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  readonly notes?: string;
}

export class CloseInventoryDto {
  @ApiPropertyOptional({
    description:
      'Permite cerrar con más del 5% sin verificar. Requiere inventory:create:global.',
  })
  @IsOptional()
  @IsBoolean()
  readonly allowUnverified?: boolean;
}

export class QueryInventoriesDto {
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

  @ApiPropertyOptional({ enum: InventoryStatus })
  @IsOptional()
  @IsEnum(InventoryStatus)
  readonly status?: InventoryStatus;

  @ApiPropertyOptional({ enum: InventoryScopeType })
  @IsOptional()
  @IsEnum(InventoryScopeType)
  readonly scope?: InventoryScopeType;
}
