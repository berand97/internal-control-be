import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { InventoryScopeType } from '../enums/inventory-scope.js';
import { InventoryStatus } from '../enums/inventory-status.js';

@Entity('physical_inventory')
export class PhysicalInventory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'code', type: 'varchar', length: 30 })
  code!: string;

  @Column({ name: 'name', type: 'varchar', length: 200 })
  name!: string;

  @Column({ name: 'scheduled_start_date', type: 'date' })
  plannedStartDate!: string;

  @Column({ name: 'scheduled_end_date', type: 'date' })
  plannedEndDate!: string;

  @Column({ name: 'actual_start_date', type: 'date', nullable: true })
  actualStartDate!: string | null;

  @Column({ name: 'actual_end_date', type: 'date', nullable: true })
  actualEndDate!: string | null;

  @Column({ name: 'status', type: 'varchar', length: 20 })
  status!: InventoryStatus;

  @Column({ name: 'responsible_user_id', type: 'uuid' })
  responsibleUserId!: string;

  @Column({ name: 'scope_type', type: 'varchar', length: 20 })
  scopeType!: InventoryScopeType;

  @Column({ name: 'scope_id', type: 'uuid', nullable: true })
  scopeId!: string | null;

  @Column({ name: 'scope_notes', type: 'text', nullable: true })
  scopeNotes!: string | null;

  @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
  closedAt!: Date | null;

  @Column({ name: 'closed_by', type: 'uuid', nullable: true })
  closedBy!: string | null;

  @Column({ name: 'reconcile_requested_at', type: 'timestamptz', nullable: true })
  reconcileRequestedAt!: Date | null;

  @Column({ name: 'reconcile_requested_by', type: 'uuid', nullable: true })
  reconcileRequestedBy!: string | null;

  @Column({ name: 'reconcile_approved_at', type: 'timestamptz', nullable: true })
  reconcileApprovedAt!: Date | null;

  @Column({ name: 'reconcile_approved_by', type: 'uuid', nullable: true })
  reconcileApprovedBy!: string | null;

  @Column({ name: 'discrepancy_report', type: 'jsonb', nullable: true })
  discrepancyReport!: Record<string, unknown> | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'created_by', type: 'uuid' })
  createdBy!: string;
}
