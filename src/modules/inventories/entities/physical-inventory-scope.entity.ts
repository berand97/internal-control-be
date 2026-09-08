import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('physical_inventory_scope')
export class PhysicalInventoryScope {
  @PrimaryColumn({ name: 'inventory_id', type: 'uuid' })
  inventoryId!: string;

  @PrimaryColumn({ name: 'cost_center_id', type: 'uuid' })
  costCenterId!: string;
}
