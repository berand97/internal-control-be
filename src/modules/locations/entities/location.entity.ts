import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { LocationType } from '../enums/location-type.enum.js';

@Entity('location')
export class Location {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'building_id', type: 'uuid' })
  buildingId!: string;

  @Column({ name: 'code', type: 'varchar', length: 30 })
  code!: string;

  @Column({ name: 'name', type: 'varchar', length: 200 })
  name!: string;

  @Column({ name: 'floor_number', type: 'smallint', nullable: true })
  floorNumber!: number | null;

  @Column({ name: 'location_type', type: 'varchar', length: 30 })
  locationType!: LocationType;

  @Column({ name: 'capacity', type: 'integer', nullable: true })
  capacity!: number | null;

  @Column({ name: 'is_active', type: 'boolean' })
  isActive!: boolean;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
