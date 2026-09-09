import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { CostCenter } from '../../cost-centers/entities/cost-center.entity.js';
import { OrganizationalUnit } from '../../organizational-units/entities/organizational-unit.entity.js';

@Entity('person')
export class Person {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'document_type', type: 'varchar', length: 10, nullable: true })
  documentType!: string | null;

  @Column({ name: 'document_number', type: 'varchar', length: 30, nullable: true })
  documentNumber!: string | null;

  @Column({ name: 'first_name', type: 'varchar', length: 100 })
  firstName!: string;

  @Column({ name: 'last_name', type: 'varchar', length: 100 })
  lastName!: string;

  @Column({ name: 'email', type: 'varchar', length: 255 })
  email!: string;

  @Column({ name: 'phone', type: 'varchar', length: 30, nullable: true })
  phone!: string | null;

  @Column({
    name: 'position_title',
    type: 'varchar',
    length: 150,
    nullable: true,
  })
  positionTitle!: string | null;

  @Column({ name: 'organizational_unit_id', type: 'uuid', nullable: true })
  organizationalUnitId!: string | null;

  @ManyToOne(() => OrganizationalUnit, { nullable: true })
  @JoinColumn({ name: 'organizational_unit_id' })
  organizationalUnit?: OrganizationalUnit | null;

  @Column({ name: 'cost_center_id', type: 'uuid', nullable: true })
  costCenterId!: string | null;

  @ManyToOne(() => CostCenter, { nullable: true })
  @JoinColumn({ name: 'cost_center_id' })
  costCenter?: CostCenter | null;

  @Column({ name: 'is_active', type: 'boolean' })
  isActive!: boolean;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
