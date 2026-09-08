import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { LoanStatus } from '../enums/loan-status.js';

@Entity('asset_loan')
export class AssetLoan {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'source_cost_center_id', type: 'uuid' })
  sourceCostCenterId!: string;

  @Column({ name: 'target_cost_center_id', type: 'uuid' })
  targetCostCenterId!: string;

  @Column({ name: 'target_location_id', type: 'uuid', nullable: true })
  targetLocationId!: string | null;

  @Column({ name: 'target_responsible_id', type: 'uuid' })
  contactPersonId!: string;

  @Column({ name: 'requested_at', type: 'timestamptz' })
  requestedAt!: Date;

  @Column({ name: 'expected_return_date', type: 'date' })
  expectedReturnDate!: string;

  @Column({ name: 'approved_at', type: 'timestamptz', nullable: true })
  approvedAt!: Date | null;

  @Column({ name: 'delivered_at', type: 'timestamptz', nullable: true })
  deliveredAt!: Date | null;

  @Column({ name: 'actual_return_date', type: 'timestamptz', nullable: true })
  actualReturnDate!: Date | null;

  @Column({ name: 'requested_by', type: 'uuid' })
  requestedBy!: string;

  @Column({ name: 'approved_by', type: 'uuid', nullable: true })
  approvedBy!: string | null;

  @Column({ name: 'delivered_by', type: 'uuid', nullable: true })
  deliveredBy!: string | null;

  @Column({ name: 'received_back_by', type: 'uuid', nullable: true })
  receivedBackBy!: string | null;

  @Column({ name: 'status', type: 'varchar', length: 30 })
  status!: LoanStatus;

  @Column({ name: 'purpose', type: 'text' })
  justification!: string;

  @Column({ name: 'conditions', type: 'text', nullable: true })
  deliveryNotes!: string | null;

  @Column({ name: 'return_notes', type: 'text', nullable: true })
  returnNotes!: string | null;

  @Column({ name: 'rejected_reason', type: 'text', nullable: true })
  rejectedReason!: string | null;

  @Column({ name: 'extension_requested_date', type: 'date', nullable: true })
  extensionRequestedDate!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
