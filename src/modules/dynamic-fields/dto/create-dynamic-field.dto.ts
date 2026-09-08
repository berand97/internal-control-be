import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
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

export class CreateDynamicFieldDto {
  @ApiProperty({ example: 'ramGB', maxLength: 50 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(/^[a-z][a-zA-Z0-9_]*$/, {
    message: 'El código debe ser camelCase o snake_case iniciando en minúscula',
  })
  readonly code!: string;

  @ApiProperty({ example: 'Memoria RAM (GB)', maxLength: 150 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  readonly label!: string;

  @ApiProperty({ enum: DYNAMIC_FIELD_TYPES, example: DynamicFieldType.Number })
  @IsIn(DYNAMIC_FIELD_TYPES)
  readonly type!: DynamicFieldType;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  readonly isRequired?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  readonly defaultValue?: string;

  @ApiPropertyOptional({ type: [String], example: ['Windows', 'macOS', 'Linux'] })
  @IsOptional()
  @IsString({ each: true })
  readonly selectOptions?: string[];

  @ApiPropertyOptional({ example: { min: 4, max: 128 } })
  @IsOptional()
  @IsObject()
  readonly validationRules?: FieldValidationRules;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  readonly orderIndex?: number;
}
