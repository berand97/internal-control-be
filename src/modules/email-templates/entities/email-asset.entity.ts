import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export const EMAIL_ASSET_MIMES = ['image/png', 'image/jpeg'] as const;
export type EmailAssetMime = (typeof EMAIL_ASSET_MIMES)[number];

@Entity('email_asset')
export class EmailAsset {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'storage_key', type: 'varchar', length: 200 })
  storageKey!: string;

  @Column({ name: 'public_url', type: 'text' })
  publicUrl!: string;

  @Column({ name: 'mime', type: 'varchar', length: 20 })
  mime!: EmailAssetMime;

  @Column({ name: 'byte_size', type: 'int' })
  byteSize!: number;

  @Column({ name: 'width', type: 'int' })
  width!: number;

  @Column({ name: 'height', type: 'int' })
  height!: number;

  @Column({ name: 'sha256', type: 'char', length: 64 })
  sha256!: string;

  @Column({ name: 'original_name', type: 'varchar', length: 120 })
  originalName!: string;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
