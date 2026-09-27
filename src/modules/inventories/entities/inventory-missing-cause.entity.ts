import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Causa de faltante (catálogo administrable; nace vacío). */
@Entity('inventory_missing_cause')
export class InventoryMissingCause {
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
