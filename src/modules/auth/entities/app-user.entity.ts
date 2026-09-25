import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { UserStatus } from '../enums/user-status.enum.js';
import { Person } from './person.entity.js';

@Entity('app_user')
export class AppUser {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'person_id', type: 'uuid' })
  personId!: string;

  @ManyToOne(() => Person, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'person_id' })
  person?: Person;

  @Column({ name: 'username', type: 'varchar', length: 255 })
  username!: string;

  @Column({ name: 'password_hash', type: 'text' })
  passwordHash!: string;

  @Column({
    name: 'status',
    type: 'enum',
    enum: UserStatus,
    enumName: 'user_status',
  })
  status!: UserStatus;

  @Column({ name: 'last_login_at', type: 'timestamptz', nullable: true })
  lastLoginAt!: Date | null;

  @Column({ name: 'must_change_password', type: 'boolean', default: false })
  mustChangePassword!: boolean;

  @Column({ name: 'mfa_enabled', type: 'boolean' })
  mfaEnabled!: boolean;

  @Column({ name: 'mfa_secret', type: 'text', nullable: true })
  mfaSecret!: string | null;

  /** Secreto TOTP en enrolamiento; no se usa para verificar hasta confirmarse. */
  @Column({
    name: 'mfa_pending_secret',
    type: 'text',
    nullable: true,
    select: false,
  })
  mfaPendingSecret?: string | null;

  @Column({
    name: 'mfa_pending_created_at',
    type: 'timestamptz',
    nullable: true,
  })
  mfaPendingCreatedAt!: Date | null;

  /** El siguiente login exige enrolar MFA aunque el rol no lo exija (reset administrativo). */
  @Column({ name: 'mfa_enrollment_required', type: 'boolean', default: false })
  mfaEnrollmentRequired!: boolean;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
