import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('asset_import_batch')
export class AssetImportBatch {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'filename', type: 'varchar', length: 255 })
  filename!: string;

  @Column({ name: 'payload', type: 'jsonb' })
  payload!: unknown;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'created_by', type: 'uuid' })
  createdBy!: string;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'committed_at', type: 'timestamptz', nullable: true })
  committedAt!: Date | null;
}
