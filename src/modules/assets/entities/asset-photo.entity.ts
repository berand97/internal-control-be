import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('asset_photo')
export class AssetPhoto {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'asset_id', type: 'uuid' })
  assetId!: string;

  @Column({ name: 'file_url', type: 'text', nullable: true })
  fileUrl!: string | null;

  @Column({ name: 'file_id', type: 'uuid', nullable: true })
  fileId!: string | null;

  @Column({ name: 'file_hash', type: 'varchar', length: 64, nullable: true })
  fileHash!: string | null;

  @Column({ name: 'is_primary', type: 'boolean' })
  isPrimary!: boolean;

  @Column({ name: 'caption', type: 'varchar', length: 200, nullable: true })
  caption!: string | null;

  @Column({ name: 'uploaded_at', type: 'timestamptz' })
  uploadedAt!: Date;

  @Column({ name: 'uploaded_by', type: 'uuid' })
  uploadedBy!: string;

  @Column({ name: 'linked_by', type: 'uuid', nullable: true })
  linkedBy!: string | null;

  @Column({ name: 'unlinked_at', type: 'timestamptz', nullable: true })
  unlinkedAt!: Date | null;
}
