import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Role } from '../../auth/entities/role.entity.js';
import { Permission } from './permission.entity.js';

@Entity('role_permission')
export class RolePermission {
  @PrimaryColumn({ name: 'role_id', type: 'uuid' })
  roleId!: string;

  @ManyToOne(() => Role, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'role_id' })
  role?: Role;

  @PrimaryColumn({ name: 'permission_id', type: 'uuid' })
  permissionId!: string;

  @ManyToOne(() => Permission, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'permission_id' })
  permission?: Permission;

  @Column({ name: 'conditions', type: 'jsonb', nullable: true })
  conditions!: Record<string, unknown> | null;

  @Column({ name: 'granted_at', type: 'timestamptz' })
  grantedAt!: Date;

  @Column({ name: 'granted_by', type: 'uuid', nullable: true })
  grantedBy!: string | null;
}
