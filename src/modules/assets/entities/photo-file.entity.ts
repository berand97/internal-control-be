import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { StorageDriver } from '../../../config/configuration.js';

export type PhotoContentType = 'image/jpeg' | 'image/png' | 'image/webp';

@Entity('photo_file')
export class PhotoFile {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'storage_driver', type: 'varchar', length: 20 })
  storageDriver!: StorageDriver;

  @Column({ name: 'storage_key', type: 'varchar', length: 1024 })
  storageKey!: string;

  @Column({ name: 'thumb_key', type: 'varchar', length: 1024 })
  thumbKey!: string;

  @Column({ name: 'sha256', type: 'varchar', length: 64 })
  sha256!: string;

  @Column({ name: 'content_type', type: 'varchar', length: 40 })
  contentType!: PhotoContentType;

  @Column({ name: 'byte_size', type: 'integer' })
  byteSize!: number;

  @Column({ name: 'width', type: 'integer' })
  width!: number;

  @Column({ name: 'height', type: 'integer' })
  height!: number;

  @Column({ name: 'cost_center_id', type: 'uuid' })
  costCenterId!: string;

  @Column({ name: 'upload_year', type: 'smallint' })
  uploadYear!: number;

  @Column({ name: 'origin_asset_id', type: 'uuid', nullable: true })
  originAssetId!: string | null;

  @Column({ name: 'uploaded_by', type: 'uuid' })
  uploadedBy!: string;

  @Column({ name: 'uploaded_at', type: 'timestamptz' })
  uploadedAt!: Date;
}
