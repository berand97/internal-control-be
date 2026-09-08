import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('asset_photo')
export class AssetPhoto {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'asset_id', type: 'uuid' })
  assetId!: string;

  @Column({ name: 'file_url', type: 'text' })
  fileUrl!: string;

  @Column({ name: 'is_primary', type: 'boolean' })
  isPrimary!: boolean;

  @Column({ name: 'uploaded_at', type: 'timestamptz' })
  uploadedAt!: Date;

  @Column({ name: 'uploaded_by', type: 'uuid' })
  uploadedBy!: string;
}
