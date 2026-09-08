import { ApiProperty } from '@nestjs/swagger';
import type { AssetCategoryField } from '../../entities/asset-category-field.entity.js';
import { DynamicFieldType } from '../../enums/dynamic-field-type.enum.js';
import type { FieldValidationRules } from '../../validation/field-definition.js';

export class DynamicFieldResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ format: 'uuid' })
  readonly categoryId!: string;

  @ApiProperty()
  readonly code!: string;

  @ApiProperty()
  readonly label!: string;

  @ApiProperty({ enum: DynamicFieldType })
  readonly type!: DynamicFieldType;

  @ApiProperty()
  readonly isRequired!: boolean;

  @ApiProperty({ nullable: true })
  readonly defaultValue!: string | null;

  @ApiProperty({ type: [String], nullable: true })
  readonly selectOptions!: ReadonlyArray<string> | null;

  @ApiProperty({ nullable: true })
  readonly validationRules!: FieldValidationRules | null;

  @ApiProperty()
  readonly orderIndex!: number;

  @ApiProperty()
  readonly isActive!: boolean;

  @ApiProperty({
    description: 'true si el campo viene de un ancestro',
  })
  readonly inherited!: boolean;

  @ApiProperty({ format: 'uuid', nullable: true })
  readonly inheritedFromCategoryId!: string | null;

  static from(
    field: AssetCategoryField,
    inherited = false,
  ): DynamicFieldResponseDto {
    return {
      id: field.id,
      categoryId: field.categoryId,
      code: field.code,
      label: field.label,
      type: field.type,
      isRequired: field.isRequired,
      defaultValue: field.defaultValue,
      selectOptions: field.selectOptions,
      validationRules: field.validationRules,
      orderIndex: field.orderIndex,
      isActive: field.isActive,
      inherited,
      inheritedFromCategoryId: inherited ? field.categoryId : null,
    };
  }
}
