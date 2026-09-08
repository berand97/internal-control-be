import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('qr_token_rotation_log')
export class QrTokenRotationLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'asset_id', type: 'uuid' })
  assetId!: string;

  @Column({ name: 'token_version', type: 'smallint' })
  tokenVersion!: number;

  @Column({ name: 'jti', type: 'varchar', length: 64 })
  jti!: string;

  @Column({ name: 'action', type: 'varchar', length: 20 })
  action!: 'ISSUED' | 'REVOKED';

  @Column({ name: 'performed_by', type: 'uuid', nullable: true })
  performedBy!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
