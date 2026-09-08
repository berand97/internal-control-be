import { Column, Entity, PrimaryColumn } from 'typeorm';
import { RefreshTokenFamilyStatus } from '../enums/refresh-token-family-status.enum.js';

@Entity('refresh_token_family')
export class RefreshTokenFamily {
  @PrimaryColumn({ name: 'id', type: 'uuid' })
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({
    name: 'status',
    type: 'enum',
    enum: RefreshTokenFamilyStatus,
    enumName: 'refresh_token_family_status',
  })
  status!: RefreshTokenFamilyStatus;

  @Column({ name: 'current_jti', type: 'uuid' })
  currentJti!: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
