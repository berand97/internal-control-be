import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { DepreciationMethod } from '../enums/depreciation-method.enum.js';

@Entity('asset_category')
export class AssetCategory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'parent_id', type: 'uuid', nullable: true })
  parentId!: string | null;

  @Column({ name: 'code', type: 'varchar', length: 30 })
  code!: string;

  @Column({ name: 'name', type: 'varchar', length: 200 })
  name!: string;

  @Column({ name: 'description', type: 'text', nullable: true })
  description!: string | null;

  @Column({ name: 'default_useful_life_years', type: 'smallint', nullable: true })
  depreciationYears!: number | null;

  @Column({
    name: 'default_depreciation_method',
    type: 'enum',
    enum: DepreciationMethod,
    enumName: 'depreciation_method',
  })
  depreciationMethod!: DepreciationMethod;

  @Column({ name: 'requires_serial_number', type: 'boolean' })
  requiresSerialNumber!: boolean;

  @Column({ name: 'requires_photo', type: 'boolean' })
  requiresPhoto!: boolean;

  @Column({ name: 'hierarchy_path', type: 'text', nullable: true })
  hierarchyPath!: string | null;

  @Column({ name: 'is_active', type: 'boolean' })
  isActive!: boolean;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
