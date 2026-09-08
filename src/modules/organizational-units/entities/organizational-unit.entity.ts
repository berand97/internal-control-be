import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { OrgUnitType } from '../enums/org-unit-type.enum.js';

@Entity('organizational_unit')
export class OrganizationalUnit {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'parent_id', type: 'uuid', nullable: true })
  parentId!: string | null;

  @Column({ name: 'code', type: 'varchar', length: 20 })
  code!: string;

  @Column({ name: 'name', type: 'varchar', length: 200 })
  name!: string;

  @Column({ name: 'unit_type', type: 'varchar', length: 30 })
  unitType!: OrgUnitType;

  @Column({ name: 'hierarchy_level', type: 'smallint' })
  hierarchyLevel!: number;

  @Column({ name: 'hierarchy_path', type: 'text', nullable: true })
  hierarchyPath!: string | null;

  @Column({ name: 'is_active', type: 'boolean' })
  isActive!: boolean;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
