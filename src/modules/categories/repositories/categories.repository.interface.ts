import type { DepreciationMethod } from '../enums/depreciation-method.enum.js';
import type { AssetCategory } from '../entities/asset-category.entity.js';

export interface CreateCategoryRecord {
  readonly parentId: string | null;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly depreciationYears: number | null;
  readonly depreciationMethod: DepreciationMethod;
  readonly requiresSerialNumber: boolean;
  readonly requiresPhoto: boolean;
  readonly hierarchyPath: string;
  readonly isActive: boolean;
}

export interface UpdateCategoryRecord {
  readonly parentId?: string | null;
  readonly code?: string;
  readonly name?: string;
  readonly description?: string | null;
  readonly depreciationYears?: number | null;
  readonly depreciationMethod?: DepreciationMethod;
  readonly requiresSerialNumber?: boolean;
  readonly requiresPhoto?: boolean;
  readonly hierarchyPath?: string;
  readonly isActive?: boolean;
}

export interface CategorySearchFilters {
  readonly q?: string;
  readonly parentId?: string | null;
  readonly isActive?: boolean;
}

export interface CategoriesRepository {
  findAll(filters: CategorySearchFilters): Promise<ReadonlyArray<AssetCategory>>;
  findById(id: string): Promise<AssetCategory | null>;
  insert(record: CreateCategoryRecord): Promise<AssetCategory>;
  update(id: string, record: UpdateCategoryRecord): Promise<void>;
  deactivate(id: string): Promise<void>;
  countActiveChildren(parentId: string): Promise<number>;
  countAssets(categoryId: string): Promise<number>;
  rewriteDescendantPaths(
    oldPath: string,
    newPath: string,
  ): Promise<void>;
}
