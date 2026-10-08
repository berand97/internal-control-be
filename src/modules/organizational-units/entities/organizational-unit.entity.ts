import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { OrgRelationType, OrgUnitType } from '../enums/org-unit-type.enum.js';

@Entity('organizational_unit')
export class OrganizationalUnit {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'parent_id', type: 'uuid', nullable: true })
  parentId!: string | null;

  @Column({ name: 'code', type: 'varchar', length: 20 })
  code!: string;

  @Column({ name: 'name', type: 'varchar', length: 200 })
  name!: string;

  @Column({ name: 'unit_type', type: 'varchar', length: 30 })
  unitType!: OrgUnitType;

  @Column({ name: 'hierarchy_level', type: 'smallint' })
  hierarchyLevel!: number;

  @Column({ name: 'hierarchy_path', type: 'text', nullable: true })
  hierarchyPath!: string | null;

  /** Dígito(s) inicial(es) del rango de códigos de sus centros de costo (4 → 4000–4999). */
  @Column({ name: 'code_prefix', type: 'varchar', length: 4, nullable: true })
  codePrefix!: string | null;

  /** Línea del organigrama hacia su padre. */
  @Column({ name: 'relation_type', type: 'varchar', length: 20, default: OrgRelationType.Authority })
  relationType!: OrgRelationType;

  /**
   * Centro de costo «propio» del cuadro (unidad 25 → 2510 Decanatura), amarrado. null si no tiene o si su código aún no
   * existe (pendiente). Lo fijan el Excel, POST/PATCH y el conciliador de estructura.
   */
  @Column({ name: 'head_cost_center_id', type: 'uuid', nullable: true })
  headCostCenterId!: string | null;

  /** Código del centro propio tal como se escribió; con head_cost_center_id null queda pendiente. */
  @Column({ name: 'head_cost_center_code', type: 'varchar', length: 20, nullable: true })
  headCostCenterCode!: string | null;

  @Column({ name: 'is_active', type: 'boolean' })
  isActive!: boolean;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
