import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export const AGREEMENT_STATUSES = ['PENDING', 'AGREED', 'OBJECTED'] as const;
export type AgreementStatus = (typeof AGREEMENT_STATUSES)[number];

@Entity('physical_inventory_act_agreement')
export class PhysicalInventoryActAgreement {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'act_id', type: 'uuid' })
  actId!: string;

  @Column({ name: 'status', type: 'varchar', length: 20 })
  status!: AgreementStatus;

  @Column({ name: 'head_person_id', type: 'uuid' })
  headPersonId!: string;

  @Column({ name: 'comment', type: 'text', nullable: true })
  comment!: string | null;

  @Column({ name: 'responded_at', type: 'timestamptz', nullable: true })
  respondedAt!: Date | null;

  @Column({ name: 'summary_snapshot', type: 'jsonb' })
  summarySnapshot!: Record<string, unknown>;

  @Column({ name: 'issued_with_objection', type: 'boolean', default: false })
  issuedWithObjection!: boolean;

  @Column({ name: 'issue_objection_reason', type: 'text', nullable: true })
  issueObjectionReason!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'NOW()' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'NOW()' })
  updatedAt!: Date;
}
