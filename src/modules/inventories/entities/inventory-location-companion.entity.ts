import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('inventory_location_companion')
export class InventoryLocationCompanion {
  @PrimaryColumn({ name: 'inventory_id', type: 'uuid' })
  inventoryId!: string;

  @PrimaryColumn({ name: 'location_id', type: 'uuid' })
  locationId!: string;

  @Column({ name: 'person_id', type: 'uuid', nullable: true })
  personId!: string | null;

  @Column({ name: 'name', type: 'varchar', length: 200, nullable: true })
  name!: string | null;

  @Column({ name: 'recorded_at', type: 'timestamptz' })
  recordedAt!: Date;

  @Column({ name: 'recorded_by', type: 'uuid' })
  recordedBy!: string;
}
