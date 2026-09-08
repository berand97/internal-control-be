import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { SodConstraintType } from '../enums/sod-constraint-type.enum.js';

@Entity('role_separation_of_duties')
export class RoleSeparationOfDuties {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'role_a_id', type: 'uuid' })
  roleAId!: string;

  @Column({ name: 'role_b_id', type: 'uuid' })
  roleBId!: string;

  @Column({ name: 'constraint_type', type: 'varchar', length: 20 })
  constraintType!: SodConstraintType;

  @Column({ name: 'reason', type: 'text' })
  reason!: string;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
