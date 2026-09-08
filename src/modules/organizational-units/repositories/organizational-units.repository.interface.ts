import type { OrganizationalUnit } from '../entities/organizational-unit.entity.js';
import type { OrgUnitType } from '../enums/org-unit-type.enum.js';

export interface CreateOrgUnitRecord {
  readonly parentId: string | null;
  readonly code: string;
  readonly name: string;
  readonly unitType: OrgUnitType;
  readonly hierarchyLevel: number;
  readonly hierarchyPath: string;
  readonly isActive: boolean;
}

export interface UpdateOrgUnitRecord {
  readonly parentId?: string | null;
  readonly code?: string;
  readonly name?: string;
  readonly unitType?: OrgUnitType;
  readonly hierarchyLevel?: number;
  readonly hierarchyPath?: string;
  readonly isActive?: boolean;
}

export interface OrganizationalUnitsRepository {
  findAll(isActive?: boolean): Promise<ReadonlyArray<OrganizationalUnit>>;
  findById(id: string): Promise<OrganizationalUnit | null>;
  findActiveById(id: string): Promise<OrganizationalUnit | null>;
  findByCode(code: string): Promise<OrganizationalUnit | null>;
  findChildren(parentId: string): Promise<ReadonlyArray<OrganizationalUnit>>;
  countActiveChildren(parentId: string): Promise<number>;
  countCostCenters(orgUnitId: string): Promise<number>;
  insert(record: CreateOrgUnitRecord): Promise<OrganizationalUnit>;
  update(id: string, record: UpdateOrgUnitRecord): Promise<void>;
  deactivate(id: string): Promise<void>;
  rewriteDescendantPaths(
    oldPath: string,
    newPath: string,
    levelDelta: number,
  ): Promise<void>;
}
