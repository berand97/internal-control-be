import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { AppUser } from './app-user.entity.js';
import { Role } from './role.entity.js';

@Entity('user_role')
export class UserRole {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @ManyToOne(() => AppUser, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'user_id' })
  user?: AppUser;

  @Column({ name: 'role_id', type: 'uuid' })
  roleId!: string;

  @ManyToOne(() => Role, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'role_id' })
  role?: Role;

  @Column({ name: 'scope_type', type: 'varchar', length: 20 })
  scopeType!: string;

  @Column({ name: 'scope_id', type: 'uuid', nullable: true })
  scopeId!: string | null;

  @Column({ name: 'valid_from', type: 'timestamptz' })
  validFrom!: Date;

  @Column({ name: 'valid_until', type: 'timestamptz', nullable: true })
  validUntil!: Date | null;

  @Column({ name: 'is_delegated', type: 'boolean' })
  isDelegated!: boolean;

  @Column({ name: 'delegated_from_user_id', type: 'uuid', nullable: true })
  delegatedFromUserId!: string | null;

  @Column({ name: 'delegation_reason', type: 'text', nullable: true })
  delegationReason!: string | null;

  @Column({ name: 'granted_at', type: 'timestamptz' })
  grantedAt!: Date;

  @Column({ name: 'granted_by', type: 'uuid', nullable: true })
  grantedBy!: string | null;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @Column({ name: 'revoked_by', type: 'uuid', nullable: true })
  revokedBy!: string | null;

  @Column({ name: 'revocation_reason', type: 'text', nullable: true })
  revocationReason!: string | null;
}
