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

  /** Veces que se movieron las fechas; también es la revisión vigente de los recordatorios (schedule_rev). */
  @Column({ name: 'reschedule_count', type: 'integer', default: 0 })
  rescheduleCount!: number;

  @Column({ name: 'rescheduled_at', type: 'timestamptz', nullable: true })
  rescheduledAt!: Date | null;

  /** Días antes del inicio en que se envía recordatorio. Vacío en las tomas anteriores a la programación. */
  @Column({ name: 'reminder_offsets_days', type: 'smallint', array: true, default: () => "'{}'" })
  reminderOffsetsDays!: number[];

  @Column({ name: 'cancel_reason', type: 'text', nullable: true })
  cancelReason!: string | null;

  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt!: Date | null;

  @Column({ name: 'cancelled_by', type: 'uuid', nullable: true })
  cancelledBy!: string | null;

  /** Corte contable contra el que se concilia; NULL = contra la foto del sistema. */
  @Column({ name: 'accounting_cut_id', type: 'uuid', nullable: true })
  accountingCutId!: string | null;

  /** Instante en que start() congeló la foto; NULL en tomas iniciadas antes de guardarlo. */
  @Column({ name: 'snapshot_taken_at', type: 'timestamptz', nullable: true })
  snapshotTakenAt!: Date | null;

  /** Solicitud del outbox del acta OCI-21-37, encolada al aprobar la conciliación. */
  @Column({ name: 'act_request_id', type: 'uuid', nullable: true })
  actRequestId!: string | null;

  /** Acta OCI-21-37 generada (la guarda onGenerated). */
  @Column({ name: 'act_document_id', type: 'uuid', nullable: true })
  actDocumentId!: string | null;

  /** Por qué el acta no se encoló (FORMAT_NOT_READY o ENQUEUE_FAILED). */
  @Column({ name: 'act_blocked_code', type: 'varchar', length: 40, nullable: true })
  actBlockedCode!: string | null;

  @Column({ name: 'act_blocked_message', type: 'text', nullable: true })
  actBlockedMessage!: string | null;

  @Column({ name: 'act_blocked_at', type: 'timestamptz', nullable: true })
  actBlockedAt!: Date | null;

  /**
   * Jefe vigente del centro de la toma que firma el acta OCI-21-37 como ENCARGADO (turno RESPONSABLE), resuelto al
   * cerrar (migración 1767225980000). NULL: el centro no tenía jefe vigente (el acta no se emite hasta indicarlo) o la
   * toma se cerró antes de esta regla.
   */
  @Column({ name: 'signer_head_person_id', type: 'uuid', nullable: true })
  signerHeadPersonId!: string | null;

  @Column({ name: 'signer_head_recorded_at', type: 'timestamptz', nullable: true })
  signerHeadRecordedAt!: Date | null;

  @Column({ name: 'signer_head_recorded_by', type: 'uuid', nullable: true })
  signerHeadRecordedBy!: string | null;

  /** Quién atendió la toma por el área, si es persona del sistema. Solo informativo: no firma. */
  @Column({ name: 'attended_by_person_id', type: 'uuid', nullable: true })
  attendedByPersonId!: string | null;

  /** Quién atendió por el área, en texto libre, si no está registrado. Nunca junto con attendedByPersonId. */
  @Column({ name: 'attended_by_name', type: 'varchar', length: 200, nullable: true })
  attendedByName!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'created_by', type: 'uuid' })
  createdBy!: string;
}
