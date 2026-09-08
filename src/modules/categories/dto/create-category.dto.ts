import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import {
  DEPRECIATION_METHODS,
  DepreciationMethod,
} from '../enums/depreciation-method.enum.js';

export class CreateCategoryDto {
  @ApiProperty({ example: 'COMPUTADORES', maxLength: 30 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  @Matches(/^[A-Z][A-Z0-9_]*$/, {
    message: 'El código debe ser SCREAMING_SNAKE_CASE',
  })
  readonly code!: string;

  @ApiProperty({ example: 'Computadores', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  readonly name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  readonly description?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  readonly parentId?: string;

  @ApiPropertyOptional({ minimum: 1, example: 5 })
  @IsOptional()
  @IsInt()
  @Min(1)
  readonly depreciationYears?: number;

  @ApiPropertyOptional({
    enum: DEPRECIATION_METHODS,
    default: DepreciationMethod.StraightLine,
  })
  @IsOptional()
  @IsIn(DEPRECIATION_METHODS)
  readonly depreciationMethod?: DepreciationMethod;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  readonly requiresSerialNumber?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  readonly requiresPhoto?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  readonly isActive?: boolean;
}
