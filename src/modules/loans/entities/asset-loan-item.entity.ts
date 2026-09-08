import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { OperationalStatus } from '../../assets/enums/operational-status.enum.js';
import type { PhysicalCondition } from '../../assets/enums/physical-condition.enum.js';
import type { LoanReturnCondition } from '../enums/loan-status.js';

@Entity('asset_loan_item')
export class AssetLoanItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'loan_id', type: 'uuid' })
  loanId!: string;

  @Column({ name: 'asset_id', type: 'uuid' })
  assetId!: string;

  @Column({ name: 'source_cost_center_id', type: 'uuid' })
  sourceCostCenterId!: string;

  @Column({
    name: 'status_on_loan',
    type: 'varchar',
    length: 30,
    nullable: true,
  })
  statusOnLoan!: OperationalStatus | null;

  @Column({
    name: 'condition_on_delivery',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  conditionOnDelivery!: PhysicalCondition | null;

  @Column({ name: 'return_condition', type: 'varchar', length: 20, nullable: true })
  returnCondition!: LoanReturnCondition | null;

  @Column({ name: 'returned_at', type: 'timestamptz', nullable: true })
  returnedAt!: Date | null;
}

@Entity('asset_loan_event')
export class AssetLoanEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'loan_id', type: 'uuid' })
  loanId!: string;

  @Column({ name: 'event_type', type: 'varchar', length: 40 })
  eventType!: string;

  @Column({ name: 'payload', type: 'jsonb', nullable: true })
  payload!: Record<string, unknown> | null;

  @Column({ name: 'performed_by', type: 'uuid' })
  performedBy!: string;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

@Entity('loan_attachment')
export class LoanAttachment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'loan_id', type: 'uuid' })
  loanId!: string;

  @Column({ name: 'kind', type: 'varchar', length: 40 })
  kind!: string;

  @Column({ name: 'storage_key', type: 'text' })
  storageKey!: string;

  @Column({ name: 'file_hash', type: 'varchar', length: 64 })
  fileHash!: string;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'created_by', type: 'uuid' })
  createdBy!: string;
}
