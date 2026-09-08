import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { PhysicalCondition } from '../../assets/enums/physical-condition.enum.js';
import { VerificationResult } from '../enums/verification-result.js';

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
}
