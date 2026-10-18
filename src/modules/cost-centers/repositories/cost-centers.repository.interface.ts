import type { EntityManager } from 'typeorm';
import type { OrganizationalUnit } from '../../organizational-units/entities/organizational-unit.entity.js';
import type { CostCenter } from '../entities/cost-center.entity.js';
import type { CostCenterSyncSource } from '../enums/cost-center-sync-source.enum.js';

export interface CreateCostCenterRecord {
  readonly externalCode: string;
  readonly name: string;
  readonly organizationalUnitId: string | null;
  readonly parentId: string | null;
  readonly acceptsAssets: boolean;
  readonly hasMovement?: boolean;
  readonly isActive: boolean;
  readonly syncSource: CostCenterSyncSource;
  readonly lastSyncedAt: Date | null;
}

export interface UpdateCostCenterRecord {
  readonly name?: string;
  readonly organizationalUnitId?: string | null;
  readonly parentId?: string | null;
  readonly acceptsAssets?: boolean;
  readonly isActive?: boolean;
  readonly syncSource?: CostCenterSyncSource;
  readonly lastSyncedAt?: Date | null;
}

export interface CostCenterSearchFilters {
  readonly q?: string;
  readonly organizationalUnitId?: string;
  readonly isActive?: boolean;
}

export interface CostCentersRepository {
  findAll(
    filters: CostCenterSearchFilters,
  ): Promise<ReadonlyArray<CostCenter>>;
  findById(id: string): Promise<CostCenter | null>;
  findActiveById(id: string): Promise<CostCenter | null>;
  findOrgUnitById(id: string): Promise<OrganizationalUnit | null>;
  insert(record: CreateCostCenterRecord, manager?: EntityManager): Promise<CostCenter>;
  update(id: string, record: UpdateCostCenterRecord, manager?: EntityManager): Promise<void>;
}
