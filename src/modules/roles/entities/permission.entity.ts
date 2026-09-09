import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { PermissionScopeLevel } from '../enums/permission-scope-level.enum.js';

@Entity('permission')
export class Permission {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'code', type: 'varchar', length: 100 })
  code!: string;

  @Column({ name: 'module', type: 'varchar', length: 50 })
  module!: string;

  @Column({ name: 'resource_type', type: 'varchar', length: 50 })
  resourceType!: string;

  @Column({ name: 'resource_label', type: 'varchar', length: 80 })
  resourceLabel!: string;

  @Column({ name: 'action', type: 'varchar', length: 30 })
  action!: string;

  @Column({
    name: 'scope_level',
    type: 'enum',
    enum: PermissionScopeLevel,
    enumName: 'permission_scope_level',
  })
  scopeLevel!: PermissionScopeLevel;

  @Column({ name: 'description', type: 'text', nullable: true })
  description!: string | null;

  @Column({ name: 'is_system', type: 'boolean' })
  isSystem!: boolean;
}
