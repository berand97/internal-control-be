import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsOptional, Min, ValidateIf } from 'class-validator';
import {
  DEPRECIATION_METHODS,
  DepreciationMethod,
} from '../../categories/enums/depreciation-method.enum.js';

export class ConfigureAssetAccountingDto {
  @ApiPropertyOptional({ minimum: 1, example: 5, nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  readonly usefulLifeYears?: number | null;

  @ApiPropertyOptional({ enum: DEPRECIATION_METHODS })
  @IsOptional()
  @IsIn(DEPRECIATION_METHODS)
  readonly depreciationMethod?: DepreciationMethod;

  @ApiPropertyOptional({ minimum: 0, example: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  readonly salvageValue?: number;
}
