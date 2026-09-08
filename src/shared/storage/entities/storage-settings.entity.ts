import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { S3Provider, StorageDriver } from '../../../config/configuration.js';

@Entity('storage_settings')
export class StorageSettings {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'driver', type: 'varchar', length: 20 })
  driver!: StorageDriver;

  @Column({ name: 'project_path', type: 'text', nullable: true })
  projectPath!: string | null;

  @Column({ name: 's3_provider', type: 'varchar', length: 30, nullable: true })
  s3Provider!: S3Provider | null;

  @Column({ name: 's3_endpoint', type: 'text', nullable: true })
  s3Endpoint!: string | null;

  @Column({ name: 's3_region', type: 'varchar', length: 50, nullable: true })
  s3Region!: string | null;

  @Column({ name: 's3_bucket', type: 'varchar', length: 200, nullable: true })
  s3Bucket!: string | null;

  @Column({ name: 's3_access_key', type: 'text', nullable: true })
  s3AccessKey!: string | null;

  @Column({ name: 's3_secret_key', type: 'text', nullable: true })
  s3SecretKey!: string | null;

  @Column({ name: 's3_force_path_style', type: 'boolean', nullable: true })
  s3ForcePathStyle!: boolean | null;

  @Column({ name: 'google_client_id', type: 'text', nullable: true })
  googleClientId!: string | null;

  @Column({ name: 'google_client_secret', type: 'text', nullable: true })
  googleClientSecret!: string | null;

  @Column({ name: 'google_refresh_token', type: 'text', nullable: true })
  googleRefreshToken!: string | null;

  @Column({ name: 'google_folder_id', type: 'text', nullable: true })
  googleFolderId!: string | null;

  @Column({ name: 'onedrive_tenant_id', type: 'text', nullable: true })
  onedriveTenantId!: string | null;

  @Column({ name: 'onedrive_client_id', type: 'text', nullable: true })
  onedriveClientId!: string | null;

  @Column({ name: 'onedrive_client_secret', type: 'text', nullable: true })
  onedriveClientSecret!: string | null;

  @Column({ name: 'onedrive_refresh_token', type: 'text', nullable: true })
  onedriveRefreshToken!: string | null;

  @Column({ name: 'onedrive_folder_id', type: 'text', nullable: true })
  onedriveFolderId!: string | null;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedBy!: string | null;
}
