import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('cost_center_sync_log')
export class CostCenterSyncLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'filename', type: 'varchar', length: 255 })
  filename!: string;

  @Column({ name: 'created_count', type: 'integer' })
  createdCount!: number;

  @Column({ name: 'updated_count', type: 'integer' })
  updatedCount!: number;

  @Column({ name: 'deactivated_count', type: 'integer' })
  deactivatedCount!: number;

  @Column({ name: 'reactivated_count', type: 'integer' })
  reactivatedCount!: number;

  @Column({ name: 'performed_by', type: 'uuid', nullable: true })
  performedBy!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
