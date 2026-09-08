import type { OrganizationalUnit } from '../../organizational-units/entities/organizational-unit.entity.js';
import type { CostCenter } from '../entities/cost-center.entity.js';
import type { CostCenterSyncLog } from '../entities/cost-center-sync-log.entity.js';
import type { CostCenterSyncSource } from '../enums/cost-center-sync-source.enum.js';

export interface CreateCostCenterRecord {
  readonly externalCode: string;
  readonly name: string;
  readonly organizationalUnitId: string | null;
  readonly parentId: string | null;
  readonly acceptsAssets: boolean;
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

export interface CreateSyncLogRecord {
  readonly filename: string;
  readonly createdCount: number;
  readonly updatedCount: number;
  readonly deactivatedCount: number;
  readonly reactivatedCount: number;
  readonly performedBy: string | null;
}

export interface CostCentersRepository {
  findAll(
    filters: CostCenterSearchFilters,
  ): Promise<ReadonlyArray<CostCenter>>;
  findById(id: string): Promise<CostCenter | null>;
  findActiveById(id: string): Promise<CostCenter | null>;
  findByExternalCode(externalCode: string): Promise<CostCenter | null>;
  findOrgUnitById(id: string): Promise<OrganizationalUnit | null>;
  findOrgUnitByCode(code: string): Promise<OrganizationalUnit | null>;
  insert(record: CreateCostCenterRecord): Promise<CostCenter>;
  update(id: string, record: UpdateCostCenterRecord): Promise<void>;
  deactivate(id: string): Promise<void>;
  countActiveAssets(costCenterId: string): Promise<number>;
  insertSyncLog(record: CreateSyncLogRecord): Promise<CostCenterSyncLog>;
}
