import { ApiProperty } from '@nestjs/swagger';
import type { AssetCategory } from '../../entities/asset-category.entity.js';
import { DepreciationMethod } from '../../enums/depreciation-method.enum.js';

export class CategoryResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ format: 'uuid', nullable: true })
  readonly parentId!: string | null;

  @ApiProperty()
  readonly code!: string;

  @ApiProperty()
  readonly name!: string;

  @ApiProperty({ nullable: true })
  readonly description!: string | null;

  @ApiProperty({ nullable: true })
  readonly depreciationYears!: number | null;

  @ApiProperty({ enum: DepreciationMethod })
  readonly depreciationMethod!: DepreciationMethod;

  @ApiProperty()
  readonly requiresSerialNumber!: boolean;

  @ApiProperty()
  readonly requiresPhoto!: boolean;

  @ApiProperty({ nullable: true })
  readonly hierarchyPath!: string | null;

  @ApiProperty()
  readonly isActive!: boolean;

  static from(category: AssetCategory): CategoryResponseDto {
    return {
      id: category.id,
      parentId: category.parentId,
      code: category.code,
      name: category.name,
      description: category.description,
      depreciationYears: category.depreciationYears,
      depreciationMethod: category.depreciationMethod,
      requiresSerialNumber: category.requiresSerialNumber,
      requiresPhoto: category.requiresPhoto,
      hierarchyPath: category.hierarchyPath,
      isActive: category.isActive,
    };
  }
}
