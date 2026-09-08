import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('acquisition_type')
export class AcquisitionType {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'code', type: 'varchar', length: 30 })
  code!: string;

  @Column({ name: 'name', type: 'varchar', length: 100 })
  name!: string;

  @Column({ name: 'is_active', type: 'boolean' })
  isActive!: boolean;
}
