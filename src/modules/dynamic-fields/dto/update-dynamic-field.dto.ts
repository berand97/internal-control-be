import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import {
  DYNAMIC_FIELD_TYPES,
  DynamicFieldType,
} from '../enums/dynamic-field-type.enum.js';
import type { FieldValidationRules } from '../validation/field-definition.js';

export class UpdateDynamicFieldDto {
  @ApiPropertyOptional({ example: 'ramGB', maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Matches(/^[a-z][a-zA-Z0-9_]*$/, {
    message: 'El código debe ser camelCase o snake_case iniciando en minúscula',
  })
  readonly code?: string;

  @ApiPropertyOptional({ maxLength: 150 })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  readonly label?: string;

  @ApiPropertyOptional({ enum: DYNAMIC_FIELD_TYPES })
  @IsOptional()
  @IsIn(DYNAMIC_FIELD_TYPES)
  readonly type?: DynamicFieldType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  readonly isRequired?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  readonly defaultValue?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsString({ each: true })
  readonly selectOptions?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  readonly validationRules?: FieldValidationRules;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  readonly orderIndex?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  readonly isActive?: boolean;
}
