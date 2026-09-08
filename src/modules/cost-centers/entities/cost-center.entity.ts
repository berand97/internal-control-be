import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { CostCenterSyncSource } from '../enums/cost-center-sync-source.enum.js';

@Entity('cost_center')
export class CostCenter {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'external_code', type: 'varchar', length: 30 })
  externalCode!: string;

  @Column({ name: 'name', type: 'varchar', length: 200 })
  name!: string;

  @Column({ name: 'organizational_unit_id', type: 'uuid', nullable: true })
  organizationalUnitId!: string | null;

  @Column({ name: 'parent_id', type: 'uuid', nullable: true })
  parentId!: string | null;

  @Column({ name: 'accepts_assets', type: 'boolean' })
  acceptsAssets!: boolean;

  @Column({ name: 'is_active', type: 'boolean' })
  isActive!: boolean;

  @Column({ name: 'sync_source', type: 'varchar', length: 30 })
  syncSource!: CostCenterSyncSource;

  @Column({ name: 'last_synced_at', type: 'timestamptz', nullable: true })
  lastSyncedAt!: Date | null;

  @Column({ name: 'external_metadata', type: 'jsonb', nullable: true })
  externalMetadata!: Record<string, unknown> | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
