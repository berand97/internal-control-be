import type { AssetCategory } from '../../categories/entities/asset-category.entity.js';
import type { AssetCategoryField } from '../entities/asset-category-field.entity.js';
import type { DynamicFieldType } from '../enums/dynamic-field-type.enum.js';
import type { FieldValidationRules } from '../validation/field-definition.js';

export interface CreateDynamicFieldRecord {
  readonly categoryId: string;
  readonly code: string;
  readonly label: string;
  readonly type: DynamicFieldType;
  readonly isRequired: boolean;
  readonly defaultValue: string | null;
  readonly selectOptions: string[] | null;
  readonly validationRules: FieldValidationRules | null;
  readonly orderIndex: number;
  readonly isActive: boolean;
}

export interface UpdateDynamicFieldRecord {
  readonly code?: string;
  readonly label?: string;
  readonly isRequired?: boolean;
  readonly defaultValue?: string | null;
  readonly selectOptions?: string[] | null;
  readonly validationRules?: FieldValidationRules | null;
  readonly orderIndex?: number;
  readonly isActive?: boolean;
}

export interface DynamicFieldsRepository {
  findByCategory(categoryId: string): Promise<ReadonlyArray<AssetCategoryField>>;
  findById(id: string): Promise<AssetCategoryField | null>;
  findCategoryById(id: string): Promise<AssetCategory | null>;
  insert(record: CreateDynamicFieldRecord): Promise<AssetCategoryField>;
  update(id: string, record: UpdateDynamicFieldRecord): Promise<void>;
  remove(id: string): Promise<void>;
  deprecate(id: string): Promise<void>;
  countValues(fieldId: string): Promise<number>;
}
