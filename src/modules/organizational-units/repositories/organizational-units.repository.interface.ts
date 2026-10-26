import type { EntityManager } from 'typeorm';
import type { OrganizationalUnit } from '../entities/organizational-unit.entity.js';
import type { OrgRelationType, OrgUnitType } from '../enums/org-unit-type.enum.js';

export interface CreateOrgUnitRecord {
  readonly parentId: string | null;
  readonly code: string;
  readonly name: string;
  readonly unitType: OrgUnitType;
  readonly hierarchyLevel: number;
  readonly hierarchyPath: string;
  readonly isActive: boolean;
  readonly codePrefix: string | null;
  readonly relationType?: OrgRelationType;
  readonly headCostCenterId?: string | null;
  readonly headCostCenterCode?: string | null;
  readonly color?: string | null;
}

export interface UpdateOrgUnitRecord {
  readonly parentId?: string | null;
  readonly code?: string;
  readonly name?: string;
  readonly unitType?: OrgUnitType;
  readonly hierarchyLevel?: number;
  readonly hierarchyPath?: string;
  readonly isActive?: boolean;
  readonly codePrefix?: string | null;
  readonly relationType?: OrgRelationType;
  readonly headCostCenterId?: string | null;
  readonly headCostCenterCode?: string | null;
  readonly color?: string | null;
}

export interface UnitCostCenterRecord {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly acceptsAssets: boolean;
  readonly headPersonId: string | null;
  readonly headFullName: string | null;
  readonly assetCount: number;
}

export interface OrganizationalUnitsRepository {
  findAll(isActive?: boolean): Promise<ReadonlyArray<OrganizationalUnit>>;
  findById(id: string): Promise<OrganizationalUnit | null>;
  findActiveById(id: string): Promise<OrganizationalUnit | null>;
  findByCode(code: string): Promise<OrganizationalUnit | null>;
  findActiveByCodePrefix(codePrefix: string): Promise<OrganizationalUnit | null>;
  findChildren(parentId: string): Promise<ReadonlyArray<OrganizationalUnit>>;
  countActiveChildren(parentId: string): Promise<number>;
  countActiveCostCenters(orgUnitId: string): Promise<number>;
  countArchivedChildren(parentId: string): Promise<number>;
  countArchivedCostCenters(orgUnitId: string): Promise<number>;
  findActiveCostCentersOfUnit(orgUnitId: string, at: Date): Promise<ReadonlyArray<UnitCostCenterRecord>>;
  costCenterExists(id: string): Promise<boolean>;
  costCenterCode(id: string): Promise<string | null>;
  findCostCenterByCode(code: string): Promise<{ readonly id: string; readonly isActive: boolean } | null>;
  insert(record: CreateOrgUnitRecord, manager?: EntityManager): Promise<OrganizationalUnit>;
  update(id: string, record: UpdateOrgUnitRecord, manager?: EntityManager): Promise<void>;
  deactivate(id: string): Promise<void>;
  rewriteDescendantPaths(
    oldPath: string,
    newPath: string,
    levelDelta: number,
    manager?: EntityManager,
  ): Promise<void>;
}
