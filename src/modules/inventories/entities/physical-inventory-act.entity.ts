import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('physical_inventory_act')
export class PhysicalInventoryAct {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'inventory_id', type: 'uuid' })
  inventoryId!: string;

  @Column({ name: 'cost_center_id', type: 'uuid', nullable: true })
  costCenterId!: string | null;

  @Column({ name: 'signer_head_person_id', type: 'uuid', nullable: true })
  signerHeadPersonId!: string | null;

  @Column({ name: 'signer_head_recorded_at', type: 'timestamptz', nullable: true })
  signerHeadRecordedAt!: Date | null;

  @Column({ name: 'signer_head_recorded_by', type: 'uuid', nullable: true })
  signerHeadRecordedBy!: string | null;

  @Column({ name: 'attended_by_person_id', type: 'uuid', nullable: true })
  attendedByPersonId!: string | null;

  @Column({ name: 'attended_by_name', type: 'varchar', length: 200, nullable: true })
  attendedByName!: string | null;

  @Column({ name: 'document_request_id', type: 'uuid', nullable: true })
  documentRequestId!: string | null;

  @Column({ name: 'document_id', type: 'uuid', nullable: true })
  documentId!: string | null;

  @Column({ name: 'blocked_code', type: 'varchar', length: 40, nullable: true })
  blockedCode!: string | null;

  @Column({ name: 'blocked_message', type: 'text', nullable: true })
  blockedMessage!: string | null;

  @Column({ name: 'blocked_at', type: 'timestamptz', nullable: true })
  blockedAt!: Date | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'NOW()' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'NOW()' })
  updatedAt!: Date;
}
