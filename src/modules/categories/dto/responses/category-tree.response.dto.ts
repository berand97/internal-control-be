import { ApiProperty } from '@nestjs/swagger';
import type { AssetCategory } from '../../entities/asset-category.entity.js';
import { DepreciationMethod } from '../../enums/depreciation-method.enum.js';

export class CategoryTreeResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ format: 'uuid', nullable: true })
  readonly parentId!: string | null;

  @ApiProperty()
  readonly code!: string;

  @ApiProperty()
  readonly name!: string;

  @ApiProperty({ nullable: true })
  readonly depreciationYears!: number | null;

  @ApiProperty({ enum: DepreciationMethod })
  readonly depreciationMethod!: DepreciationMethod;

  @ApiProperty()
  readonly isActive!: boolean;

  @ApiProperty({ type: () => [CategoryTreeResponseDto] })
  readonly children!: ReadonlyArray<CategoryTreeResponseDto>;

  static from(
    category: AssetCategory,
    children: ReadonlyArray<CategoryTreeResponseDto>,
  ): CategoryTreeResponseDto {
    return {
      id: category.id,
      parentId: category.parentId,
      code: category.code,
      name: category.name,
      depreciationYears: category.depreciationYears,
      depreciationMethod: category.depreciationMethod,
      isActive: category.isActive,
      children,
    };
  }
}
