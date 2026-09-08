import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { DepreciationMethod } from '../../categories/enums/depreciation-method.enum.js';

@Entity('asset_depreciation')
export class AssetDepreciation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'asset_id', type: 'uuid' })
  assetId!: string;

  @Column({ name: 'period_year', type: 'smallint' })
  periodYear!: number;

  @Column({ name: 'period_month', type: 'smallint' })
  periodMonth!: number;

  @Column({
    name: 'method',
    type: 'enum',
    enum: DepreciationMethod,
    enumName: 'depreciation_method',
  })
  method!: DepreciationMethod;

  @Column({ name: 'monthly_depreciation', type: 'numeric', precision: 15, scale: 2 })
  monthlyDepreciation!: string;

  @Column({ name: 'accumulated_depreciation', type: 'numeric', precision: 15, scale: 2 })
  accumulatedDepreciation!: string;

  @Column({ name: 'book_value', type: 'numeric', precision: 15, scale: 2 })
  bookValue!: string;

  @Column({ name: 'is_closed', type: 'boolean' })
  isClosed!: boolean;

  @Column({ name: 'calculated_at', type: 'timestamptz' })
  calculatedAt!: Date;

  @Column({ name: 'calculated_by', type: 'uuid', nullable: true })
  calculatedBy!: string | null;
}
