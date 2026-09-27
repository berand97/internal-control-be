import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { PhysicalCondition } from '../../assets/enums/physical-condition.enum.js';
import { VerificationResult } from '../enums/verification-result.js';

export const SURPLUS_RESOLUTIONS = ['CREATE_ASSET', 'LEAVE_UNRESOLVED'] as const;
export type SurplusResolution = (typeof SURPLUS_RESOLUTIONS)[number];

@Entity('physical_inventory_item')
export class PhysicalInventoryItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'inventory_id', type: 'uuid' })
  inventoryId!: string;

  @Column({ name: 'asset_id', type: 'uuid', nullable: true })
  assetId!: string | null;

  @Column({ name: 'verification_result', type: 'varchar', length: 20 })
  verificationResult!: VerificationResult;

  @Column({ name: 'expected_location_id', type: 'uuid', nullable: true })
  expectedLocationId!: string | null;

  @Column({ name: 'actual_location_id', type: 'uuid', nullable: true })
  actualLocationId!: string | null;

  @Column({
    name: 'expected_condition',
    type: 'enum',
    enum: PhysicalCondition,
    enumName: 'asset_physical_condition',
    nullable: true,
  })
  expectedCondition!: PhysicalCondition | null;

  @Column({
    name: 'actual_condition',
    type: 'enum',
    enum: PhysicalCondition,
    enumName: 'asset_physical_condition',
    nullable: true,
  })
  actualCondition!: PhysicalCondition | null;

  @Column({ name: 'expected_cost_center_id', type: 'uuid', nullable: true })
  expectedCostCenterId!: string | null;

  @Column({ name: 'is_on_loan', type: 'boolean' })
  isOnLoan!: boolean;

  @Column({ name: 'verified_at', type: 'timestamptz', nullable: true })
  verifiedAt!: Date | null;

  @Column({ name: 'verified_by', type: 'uuid', nullable: true })
  verifiedBy!: string | null;

  @Column({ name: 'notes', type: 'text', nullable: true })
  notes!: string | null;

  @Column({ name: 'photo_url', type: 'text', nullable: true })
  photoUrl!: string | null;

  /** Código del catálogo inventory_finding_category; lo fija el auditor, nunca el sistema. */
  @Column({ name: 'finding_category_code', type: 'varchar', length: 10, nullable: true })
  findingCategoryCode!: string | null;

  @Column({ name: 'missing_cause_id', type: 'uuid', nullable: true })
  missingCauseId!: string | null;

  /** Causa "Otra" en texto libre (3..500); excluyente con missingCauseId. */
  @Column({ name: 'missing_cause_other', type: 'text', nullable: true })
  missingCauseOther!: string | null;

  /** El activo tenía la marca BARCODE_TEMP al congelar la foto. NULL en fotos anteriores a esta columna. */
  @Column({ name: 'expected_code_temporary', type: 'boolean', nullable: true })
  expectedCodeTemporary!: boolean | null;

  /** Sobrante de un activo que estaba LOST: la conciliación no lo recupera. */
  @Column({ name: 'was_lost', type: 'boolean', default: false })
  wasLost!: boolean;

  /** Sobrante anulado por error (queda en el historial de correcciones). */
  @Column({ name: 'voided_at', type: 'timestamptz', nullable: true })
  voidedAt!: Date | null;

  /** Qué se decidió con un sobrante sin activo con la toma cerrada (CREATE_ASSET o LEAVE_UNRESOLVED). */
  @Column({ name: 'surplus_resolution', type: 'varchar', length: 20, nullable: true })
  surplusResolution!: SurplusResolution | null;

  @Column({ name: 'surplus_resolution_reason', type: 'text', nullable: true })
  surplusResolutionReason!: string | null;

  /** Activo creado a partir del sobrante (solo CREATE_ASSET). */
  @Column({ name: 'resolved_asset_id', type: 'uuid', nullable: true })
  resolvedAssetId!: string | null;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;

  @Column({ name: 'resolved_by', type: 'uuid', nullable: true })
  resolvedBy!: string | null;
}
