import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('person')
export class Person {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'document_type', type: 'varchar', length: 10 })
  documentType!: string;

  @Column({ name: 'document_number', type: 'varchar', length: 30 })
  documentNumber!: string;

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

  @Column({ name: 'is_active', type: 'boolean' })
  isActive!: boolean;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
