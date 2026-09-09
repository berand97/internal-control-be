import type { NavigationItemEntity } from '../entities/navigation-item.entity.js';

export interface CreateNavigationRecord {
  readonly module: string;
  readonly moduleLabel: string;
  readonly resource: string;
  readonly path: string;
  readonly label: string;
  readonly requiredAction: string;
  readonly sortOrder: number;
  readonly isActive: boolean;
}

export interface UpdateNavigationRecord {
  readonly module?: string;
  readonly moduleLabel?: string;
  readonly resource?: string;
  readonly path?: string;
  readonly label?: string;
  readonly requiredAction?: string;
  readonly sortOrder?: number;
  readonly isActive?: boolean;
}

export interface NavigationRepository {
  findAll(): Promise<ReadonlyArray<NavigationItemEntity>>;
  findActive(): Promise<ReadonlyArray<NavigationItemEntity>>;
  findById(id: string): Promise<NavigationItemEntity | null>;
  insert(record: CreateNavigationRecord): Promise<NavigationItemEntity>;
  update(id: string, record: UpdateNavigationRecord): Promise<void>;
  delete(id: string): Promise<boolean>;
}
