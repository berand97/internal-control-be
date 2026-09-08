import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { FieldValidationRules } from '../validation/field-definition.js';
import { DynamicFieldType } from '../enums/dynamic-field-type.enum.js';

@Entity('asset_category_field')
export class AssetCategoryField {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'category_id', type: 'uuid' })
  categoryId!: string;

  @Column({ name: 'field_code', type: 'varchar', length: 50 })
  code!: string;

  @Column({ name: 'field_label', type: 'varchar', length: 150 })
  label!: string;

  @Column({ name: 'field_type', type: 'varchar', length: 20 })
  type!: DynamicFieldType;

  @Column({ name: 'is_required', type: 'boolean' })
  isRequired!: boolean;

  @Column({ name: 'default_value', type: 'text', nullable: true })
  defaultValue!: string | null;

  @Column({ name: 'options', type: 'jsonb', nullable: true })
  selectOptions!: string[] | null;

  @Column({ name: 'validation_rules', type: 'jsonb', nullable: true })
  validationRules!: FieldValidationRules | null;

  @Column({ name: 'display_order', type: 'smallint' })
  orderIndex!: number;

  @Column({ name: 'is_active', type: 'boolean' })
  isActive!: boolean;
}
