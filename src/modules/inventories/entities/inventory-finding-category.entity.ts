import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Categoría de hallazgo de la toma física (catálogo configurable). La sugerencia sale de suggestResults y
 * suggestConditions (ver domain/finding-suggestion.ts); ningún código del sistema depende del código de la categoría.
 */
@Entity('inventory_finding_category')
export class InventoryFindingCategory {
  @PrimaryColumn({ name: 'code', type: 'varchar', length: 10 })
  code!: string;

  @Column({ name: 'label', type: 'varchar', length: 80 })
  label!: string;

  @Column({ name: 'description', type: 'text', nullable: true })
  description!: string | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ name: 'sort_order', type: 'smallint', default: 0 })
  sortOrder!: number;

  @Column({ name: 'suggest_results', type: 'text', array: true, nullable: true })
  suggestResults!: string[] | null;

  @Column({ name: 'suggest_conditions', type: 'text', array: true, nullable: true })
  suggestConditions!: string[] | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'NOW()' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'NOW()' })
  updatedAt!: Date;
}
