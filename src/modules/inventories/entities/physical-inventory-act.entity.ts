import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Acta OCI-21-37 de una toma para un centro de costo (migración 1767226000000). La ubicación define el trabajo de
 * campo, no el acta: una toma produce un acta por cada centro presente en sus ítems, firmada como ENCARGADO por el jefe
 * de ese centro. El estado de la generación se deriva de la solicitud del outbox y del documento (como antes en la
 * toma); blocked_* dice por qué no se encoló.
 */
@Entity('physical_inventory_act')
export class PhysicalInventoryAct {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'inventory_id', type: 'uuid' })
  inventoryId!: string;

  /** NULL solo en el acta única de una toma de otro alcance encolada antes de la división por centro (migrada). */
  @Column({ name: 'cost_center_id', type: 'uuid', nullable: true })
  costCenterId!: string | null;

  /** Jefe vigente del centro que firma como ENCARGADO (turno RESPONSABLE). NULL: el centro no tenía jefe o no se eligió. */
  @Column({ name: 'signer_head_person_id', type: 'uuid', nullable: true })
  signerHeadPersonId!: string | null;

  @Column({ name: 'signer_head_recorded_at', type: 'timestamptz', nullable: true })
  signerHeadRecordedAt!: Date | null;

  @Column({ name: 'signer_head_recorded_by', type: 'uuid', nullable: true })
  signerHeadRecordedBy!: string | null;

  /** Quién atendió por el área de este centro, si es persona del sistema. Solo informativo: no firma. */
  @Column({ name: 'attended_by_person_id', type: 'uuid', nullable: true })
  attendedByPersonId!: string | null;

  /** Quién atendió por el área, en texto libre. Nunca junto con attendedByPersonId. */
  @Column({ name: 'attended_by_name', type: 'varchar', length: 200, nullable: true })
  attendedByName!: string | null;

  /** Solicitud del outbox del acta, encolada al aprobar la conciliación o después. */
  @Column({ name: 'document_request_id', type: 'uuid', nullable: true })
  documentRequestId!: string | null;

  /** Acta generada (la guarda onGenerated). */
  @Column({ name: 'document_id', type: 'uuid', nullable: true })
  documentId!: string | null;

  /** Por qué el acta no se encoló (FORMAT_NOT_READY, NO_COST_CENTER_HEAD, SIGNER_HEAD_NOT_CHOSEN o ENQUEUE_FAILED). */
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
