import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { NavigationIcon } from '../../../common/authorization/navigation-icons.js';

@Entity('navigation_item')
export class NavigationItemEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'module', type: 'varchar', length: 50 })
  module!: string;

  @Column({ name: 'module_label', type: 'varchar', length: 80 })
  moduleLabel!: string;

  @Column({ name: 'resource', type: 'varchar', length: 50 })
  resource!: string;

  @Column({ name: 'path', type: 'varchar', length: 200 })
  path!: string;

  @Column({ name: 'label', type: 'varchar', length: 80 })
  label!: string;

  @Column({ name: 'required_action', type: 'varchar', length: 30 })
  requiredAction!: string;

  /** Clave del catálogo NAVIGATION_ICONS (CHECK ck_navigation_item_icon); null deja el ícono por defecto. */
  @Column({ name: 'icon', type: 'varchar', length: 40, nullable: true })
  icon!: NavigationIcon | null;

  @Column({ name: 'sort_order', type: 'int' })
  sortOrder!: number;

  @Column({ name: 'is_active', type: 'boolean' })
  isActive!: boolean;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
