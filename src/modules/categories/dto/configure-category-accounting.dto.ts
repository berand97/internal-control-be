import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, Min, ValidateIf } from 'class-validator';
import {
  DEPRECIATION_METHODS,
  DepreciationMethod,
} from '../enums/depreciation-method.enum.js';

export class ConfigureCategoryAccountingDto {
  @ApiPropertyOptional({ minimum: 1, example: 5, nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(1)
  readonly depreciationYears?: number | null;

  @ApiPropertyOptional({ enum: DEPRECIATION_METHODS })
  @IsOptional()
  @IsIn(DEPRECIATION_METHODS)
  readonly depreciationMethod?: DepreciationMethod;
}
