import type { Role } from '../../auth/entities/role.entity.js';
import type { Permission } from '../entities/permission.entity.js';
import type { RolePermission } from '../entities/role-permission.entity.js';
import type { RoleSeparationOfDuties } from '../entities/role-separation-of-duties.entity.js';

export interface CreateRoleRecord {
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly parentRoleId: string | null;
  readonly hierarchyLevel: number;
  readonly isSystem: boolean;
  readonly isAssignable: boolean;
  readonly maxConcurrentUsers: number | null;
}

export interface UpdateRoleRecord {
  readonly name?: string;
  readonly description?: string | null;
  readonly parentRoleId?: string | null;
  readonly hierarchyLevel?: number;
}

export interface RolesRepository {
  findAllActive(): Promise<ReadonlyArray<Role>>;
  findActiveById(id: string): Promise<Role | null>;
  findActiveByCode(code: string): Promise<Role | null>;
  findChildren(parentRoleId: string): Promise<ReadonlyArray<Role>>;
  insert(record: CreateRoleRecord): Promise<Role>;
  update(id: string, record: UpdateRoleRecord): Promise<void>;
  softDelete(id: string, at: Date): Promise<void>;
  listPermissions(): Promise<ReadonlyArray<Permission>>;
  findPermissionsByIds(
    ids: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<Permission>>;
  findPermissionsForRole(roleId: string): Promise<ReadonlyArray<Permission>>;
  assignPermission(
    roleId: string,
    permissionId: string,
    grantedBy: string,
  ): Promise<RolePermission>;
  replacePermissions(
    roleId: string,
    permissionIds: ReadonlyArray<string>,
    grantedBy: string,
  ): Promise<void>;
  removePermission(roleId: string, permissionId: string): Promise<boolean>;
  findSodForRole(roleId: string): Promise<ReadonlyArray<RoleSeparationOfDuties>>;
  insertSod(record: {
    readonly roleAId: string;
    readonly roleBId: string;
    readonly constraintType: RoleSeparationOfDuties['constraintType'];
    readonly reason: string;
  }): Promise<RoleSeparationOfDuties>;
  findActiveAssigneeIds(roleId: string): Promise<ReadonlyArray<string>>;
  countActiveAssignees(roleId: string): Promise<number>;
}
