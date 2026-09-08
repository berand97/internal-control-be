import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('building')
export class Building {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'campus_id', type: 'uuid' })
  campusId!: string;

  @Column({ name: 'code', type: 'varchar', length: 20 })
  code!: string;

  @Column({ name: 'name', type: 'varchar', length: 200 })
  name!: string;

  @Column({ name: 'floors_count', type: 'smallint', nullable: true })
  floorsCount!: number | null;

  @Column({ name: 'is_active', type: 'boolean' })
  isActive!: boolean;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
