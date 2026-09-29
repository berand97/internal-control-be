import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Motivo de un precio de compra cero (catálogo administrable; nace vacío, migración 1767226000000). */
@Entity('asset_price_zero_reason')
export class AssetPriceZeroReason {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'label', type: 'varchar', length: 120 })
  label!: string;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ name: 'sort_order', type: 'smallint', default: 0 })
  sortOrder!: number;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'NOW()' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'NOW()' })
  updatedAt!: Date;
}
