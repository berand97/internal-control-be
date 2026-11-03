import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { StorageDriver } from '../../../config/configuration.js';
import type { PhotoContentType } from './photo-file.entity.js';

@Entity('photo_staged_upload')
export class PhotoStagedUpload {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'storage_driver', type: 'varchar', length: 20 })
  storageDriver!: StorageDriver;

  @Column({ name: 'storage_key', type: 'varchar', length: 1024 })
  storageKey!: string;

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

  @Column({ name: 'uploaded_by', type: 'uuid' })
  uploadedBy!: string;

  @Column({ name: 'uploaded_at', type: 'timestamptz' })
  uploadedAt!: Date;

  @Column({ name: 'finalized_at', type: 'timestamptz', nullable: true })
  finalizedAt!: Date | null;
}
