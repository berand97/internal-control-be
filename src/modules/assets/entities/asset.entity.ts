import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { DepreciationMethod } from '../../categories/enums/depreciation-method.enum.js';
import { OperationalStatus } from '../enums/operational-status.enum.js';
import { PhysicalCondition } from '../enums/physical-condition.enum.js';

@Entity('asset')
export class Asset {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'internal_code', type: 'varchar', length: 30 })
  internalCode!: string;

  @Column({ name: 'barcode', type: 'varchar', length: 50, nullable: true })
  barcode!: string | null;

  @Column({ name: 'serial_number', type: 'varchar', length: 100, nullable: true })
  serialNumber!: string | null;

  @Column({ name: 'description', type: 'varchar', length: 500 })
  description!: string;

  @Column({ name: 'model', type: 'varchar', length: 150, nullable: true })
  model!: string | null;

  @Column({ name: 'category_id', type: 'uuid' })
  categoryId!: string;

  @Column({ name: 'manufacturer_id', type: 'uuid', nullable: true })
  manufacturerId!: string | null;

  @Column({ name: 'acquisition_type_id', type: 'uuid' })
  acquisitionTypeId!: string;

  @Column({ name: 'acquisition_date', type: 'date' })
  acquisitionDate!: string;

  @Column({ name: 'acquisition_document', type: 'varchar', length: 100, nullable: true })
  acquisitionDocument!: string | null;

  @Column({ name: 'supplier_id', type: 'uuid', nullable: true })
  supplierId!: string | null;

  @Column({ name: 'acquisition_price', type: 'numeric', precision: 15, scale: 2 })
  acquisitionPrice!: string;

  @Column({ name: 'currency', type: 'char', length: 3 })
  currency!: string;

  @Column({
    name: 'operational_status',
    type: 'enum',
    enum: OperationalStatus,
    enumName: 'asset_operational_status',
  })
  operationalStatus!: OperationalStatus;

  @Column({
    name: 'physical_condition',
    type: 'enum',
    enum: PhysicalCondition,
    enumName: 'asset_physical_condition',
  })
  physicalCondition!: PhysicalCondition;

  @Column({ name: 'current_cost_center_id', type: 'uuid' })
  costCenterId!: string;

  @Column({ name: 'current_location_id', type: 'uuid', nullable: true })
  locationId!: string | null;

  @Column({ name: 'current_responsible_id', type: 'uuid', nullable: true })
  responsibleId!: string | null;

  @Column({ name: 'written_off_at', type: 'date', nullable: true })
  writtenOffAt!: string | null;

  @Column({ name: 'write_off_reason', type: 'text', nullable: true })
  writeOffReason!: string | null;

  @Column({ name: 'write_off_document', type: 'varchar', length: 100, nullable: true })
  writeOffDocument!: string | null;

  @Column({ name: 'write_off_approved_by', type: 'uuid', nullable: true })
  writeOffApprovedBy!: string | null;

  @Column({ name: 'qr_token', type: 'text', nullable: true })
  qrToken!: string | null;

  @Column({ name: 'qr_token_version', type: 'smallint' })
  qrTokenVersion!: number;

  @Column({ name: 'qr_signed_at', type: 'timestamptz', nullable: true })
  qrSignedAt!: Date | null;

  @Column({ name: 'qr_signed_by', type: 'uuid', nullable: true })
  qrSignedBy!: string | null;

  @Column({
    name: 'depreciation_method',
    type: 'enum',
    enum: DepreciationMethod,
    enumName: 'depreciation_method',
  })
  depreciationMethod!: DepreciationMethod;

  @Column({ name: 'useful_life_years', type: 'smallint', nullable: true })
  usefulLifeYears!: number | null;

  @Column({ name: 'salvage_value', type: 'numeric', precision: 15, scale: 2 })
  salvageValue!: string;

  @Column({ name: 'last_verified_at', type: 'timestamptz', nullable: true })
  lastVerifiedAt!: Date | null;

  @Column({ name: 'notes', type: 'text', nullable: true })
  notes!: string | null;

  @Column({ name: 'warranty_expires_at', type: 'date', nullable: true })
  warrantyExpiresAt!: string | null;

  @Column({ name: 'insurance_policy_number', type: 'varchar', length: 80, nullable: true })
  insurancePolicyNumber!: string | null;

  @Column({ name: 'data_quality_flags', type: 'varchar', length: 40, array: true })
  dataQualityFlags!: string[];

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'created_by', type: 'uuid' })
  createdBy!: string;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedBy!: string | null;
}
