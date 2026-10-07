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
}

export interface OrganizationalUnitsRepository {
  findAll(isActive?: boolean): Promise<ReadonlyArray<OrganizationalUnit>>;
  findById(id: string): Promise<OrganizationalUnit | null>;
  findActiveById(id: string): Promise<OrganizationalUnit | null>;
  findByCode(code: string): Promise<OrganizationalUnit | null>;
  /** Unidad activa con ese prefijo de código de centros. */
  findActiveByCodePrefix(codePrefix: string): Promise<OrganizationalUnit | null>;
  findChildren(parentId: string): Promise<ReadonlyArray<OrganizationalUnit>>;
  countActiveChildren(parentId: string): Promise<number>;
  /**
   * Centros activos que hoy están en la unidad. Los inactivos no impiden desactivarla: la desactivación es lógica, así
   * que conservan su referencia y su historial de ubicación (igual que los hijos, que solo cuentan si están activos).
   */
  countActiveCostCenters(orgUnitId: string): Promise<number>;
  costCenterExists(id: string): Promise<boolean>;
  costCenterCode(id: string): Promise<string | null>;
  insert(record: CreateOrgUnitRecord): Promise<OrganizationalUnit>;
  update(id: string, record: UpdateOrgUnitRecord): Promise<void>;
  deactivate(id: string): Promise<void>;
  rewriteDescendantPaths(
    oldPath: string,
    newPath: string,
    levelDelta: number,
  ): Promise<void>;
}
