import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { MovementType } from '../enums/movement-type.enum.js';
import { OperationalStatus } from '../enums/operational-status.enum.js';
import { PhysicalCondition } from '../enums/physical-condition.enum.js';

@Entity('asset_movement')
export class AssetMovement {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'asset_id', type: 'uuid' })
  assetId!: string;

  @Column({
    name: 'movement_type',
    type: 'enum',
    enum: MovementType,
    enumName: 'movement_type',
  })
  movementType!: MovementType;

  @Column({ name: 'from_cost_center_id', type: 'uuid', nullable: true })
  fromCostCenterId!: string | null;

  @Column({ name: 'from_location_id', type: 'uuid', nullable: true })
  fromLocationId!: string | null;

  @Column({ name: 'from_responsible_id', type: 'uuid', nullable: true })
  fromResponsibleId!: string | null;

  @Column({
    name: 'from_operational_status',
    type: 'enum',
    enum: OperationalStatus,
    enumName: 'asset_operational_status',
    nullable: true,
  })
  fromOperationalStatus!: OperationalStatus | null;

  @Column({
    name: 'from_physical_condition',
    type: 'enum',
    enum: PhysicalCondition,
    enumName: 'asset_physical_condition',
    nullable: true,
  })
  fromPhysicalCondition!: PhysicalCondition | null;

  @Column({ name: 'to_cost_center_id', type: 'uuid', nullable: true })
  toCostCenterId!: string | null;

  @Column({ name: 'to_location_id', type: 'uuid', nullable: true })
  toLocationId!: string | null;

  @Column({ name: 'to_responsible_id', type: 'uuid', nullable: true })
  toResponsibleId!: string | null;

  @Column({
    name: 'to_operational_status',
    type: 'enum',
    enum: OperationalStatus,
    enumName: 'asset_operational_status',
    nullable: true,
  })
  toOperationalStatus!: OperationalStatus | null;

  @Column({
    name: 'to_physical_condition',
    type: 'enum',
    enum: PhysicalCondition,
    enumName: 'asset_physical_condition',
    nullable: true,
  })
  toPhysicalCondition!: PhysicalCondition | null;

  @Column({ name: 'requested_by', type: 'uuid', nullable: true })
  requestedBy!: string | null;

  @Column({ name: 'authorized_by', type: 'uuid', nullable: true })
  authorizedBy!: string | null;

  @Column({ name: 'executed_at', type: 'timestamptz' })
  executedAt!: Date;

  @Column({ name: 'reason', type: 'text', nullable: true })
  reason!: string | null;

  @Column({ name: 'document_reference', type: 'varchar', length: 100, nullable: true })
  documentReference!: string | null;

  @Column({ name: 'attachment_url', type: 'text', nullable: true })
  attachmentUrl!: string | null;

  @Column({ name: 'loan_id', type: 'uuid', nullable: true })
  loanId!: string | null;

  @Column({ name: 'previous_movement_id', type: 'uuid', nullable: true })
  previousMovementId!: string | null;

  @Column({ name: 'event_signature', type: 'text', nullable: true })
  eventSignature!: string | null;

  @Column({ name: 'metadata', type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @Column({ name: 'ip_address', type: 'inet', nullable: true })
  ipAddress!: string | null;

  @Column({ name: 'user_agent', type: 'text', nullable: true })
  userAgent!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
