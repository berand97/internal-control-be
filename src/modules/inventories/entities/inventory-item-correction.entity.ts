import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export const INVENTORY_CORRECTION_KINDS = ['CORRECT', 'VOID'] as const;
export type InventoryCorrectionKind = (typeof INVENTORY_CORRECTION_KINDS)[number];

/** Corrección (o anulación de un sobrante) de un ítem de toma, con el antes y el después. */
@Entity('inventory_item_correction')
export class InventoryItemCorrection {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'item_id', type: 'uuid' })
  itemId!: string;

  @Column({ name: 'inventory_id', type: 'uuid' })
  inventoryId!: string;

  @Column({ name: 'kind', type: 'varchar', length: 10 })
  kind!: InventoryCorrectionKind;

  @Column({ name: 'before', type: 'jsonb' })
  before!: Record<string, unknown>;

  @Column({ name: 'after', type: 'jsonb' })
  after!: Record<string, unknown>;

  @Column({ name: 'reason', type: 'text' })
  reason!: string;

  @Column({ name: 'corrected_by', type: 'uuid' })
  correctedBy!: string;

  @Column({ name: 'corrected_at', type: 'timestamptz', default: () => 'NOW()' })
  correctedAt!: Date;
}
