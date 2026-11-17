import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('inventory_act_agreement_link')
export class InventoryActAgreementLink {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'agreement_id', type: 'uuid' })
  agreementId!: string;

  @Column({ name: 'token_hash', type: 'text', nullable: true })
  tokenHash!: string | null;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  @Column({ name: 'consumed_at', type: 'timestamptz', nullable: true })
  consumedAt!: Date | null;

  @Column({ name: 'delivery_status', type: 'varchar', length: 20 })
  deliveryStatus!: 'PENDING_SEND' | 'SENT' | 'FAILED';

  @Column({ name: 'send_attempts', type: 'integer', default: 0 })
  sendAttempts!: number;

  @Column({ name: 'sent_at', type: 'timestamptz', nullable: true })
  sentAt!: Date | null;

  @Column({ name: 'last_send_error', type: 'text', nullable: true })
  lastSendError!: string | null;

  @Column({ name: 'reminder_day3_at', type: 'timestamptz', nullable: true })
  reminderDay3At!: Date | null;

  @Column({ name: 'reminder_day6_at', type: 'timestamptz', nullable: true })
  reminderDay6At!: Date | null;

  @Column({ name: 'invalidated_at', type: 'timestamptz', nullable: true })
  invalidatedAt!: Date | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'NOW()' })
  createdAt!: Date;
}
