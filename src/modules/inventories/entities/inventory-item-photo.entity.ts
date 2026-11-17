import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('inventory_item_photo')
export class InventoryItemPhoto {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'item_id', type: 'uuid' })
  itemId!: string;

  @Column({ name: 'storage_key', type: 'text' })
  storageKey!: string;

  @Column({ name: 'content_type', type: 'varchar', length: 64 })
  contentType!: string;

  @Column({ name: 'byte_size', type: 'int' })
  byteSize!: number;

  @Column({ name: 'taken_at', type: 'timestamptz' })
  takenAt!: Date;

  @Column({ name: 'created_by', type: 'uuid' })
  createdBy!: string;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'NOW()' })
  createdAt!: Date;
}
