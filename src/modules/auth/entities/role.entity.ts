import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('role')
export class Role {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'code', type: 'varchar', length: 50 })
  code!: string;

  @Column({ name: 'name', type: 'varchar', length: 100 })
  name!: string;

  @Column({ name: 'description', type: 'text', nullable: true })
  description!: string | null;

  @Column({ name: 'parent_role_id', type: 'uuid', nullable: true })
  parentRoleId!: string | null;

  @Column({ name: 'hierarchy_level', type: 'smallint' })
  hierarchyLevel!: number;

  @Column({ name: 'is_system', type: 'boolean' })
  isSystem!: boolean;

  @Column({ name: 'is_assignable', type: 'boolean' })
  isAssignable!: boolean;

  @Column({ name: 'max_concurrent_users', type: 'integer', nullable: true })
  maxConcurrentUsers!: number | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
