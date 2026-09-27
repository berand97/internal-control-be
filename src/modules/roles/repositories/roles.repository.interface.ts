import type { Role } from '../../auth/entities/role.entity.js';
import type { Permission } from '../entities/permission.entity.js';
import type { RolePermission } from '../entities/role-permission.entity.js';
import type { RoleSeparationOfDuties } from '../entities/role-separation-of-duties.entity.js';

export interface CreateRoleRecord {
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly parentRoleId: string | null;
  readonly superiorRoleId: string | null;
  readonly hierarchyLevel: number;
  readonly isSystem: boolean;
  readonly isAssignable: boolean;
  readonly maxConcurrentUsers: number | null;
}

export interface UpdateRoleRecord {
  readonly name?: string;
  readonly description?: string | null;
  readonly parentRoleId?: string | null;
  readonly superiorRoleId?: string | null;
  readonly hierarchyLevel?: number;
}

export interface RolesRepository {
  findAllActive(): Promise<ReadonlyArray<Role>>;
  findActiveById(id: string): Promise<Role | null>;
  /**
   * Roles vivos que el usuario tiene HOY por asignación directa (no revocada y dentro de su vigencia). Es la fuente
   * del rango para las decisiones de privilegio: nunca los roles del JWT, que pueden estar desactualizados (BE-09).
   */
  findRolesHeldBy(userId: string): Promise<ReadonlyArray<Role>>;
  findActiveByCode(code: string): Promise<Role | null>;
  findChildren(parentRoleId: string): Promise<ReadonlyArray<Role>>;
  insert(record: CreateRoleRecord): Promise<Role>;
  update(id: string, record: UpdateRoleRecord): Promise<void>;
  softDelete(id: string, at: Date): Promise<void>;
  listPermissions(): Promise<ReadonlyArray<Permission>>;
  insertPermission(record: {
    readonly code: string;
    readonly module: string;
    readonly resourceType: string;
    readonly resourceLabel: string;
    readonly action: string;
    readonly scopeLevel: Permission['scopeLevel'];
    readonly description: string | null;
    readonly isSystem: boolean;
  }): Promise<Permission>;
  updatePermission(
    id: string,
    record: { readonly description?: string | null },
  ): Promise<void>;
  deletePermission(id: string): Promise<boolean>;
  countPermissionAssignments(permissionId: string): Promise<number>;
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
  /** Titulares activos del rol o de cualquier rol vivo que lo herede (parent_role_id, recursivo). */
  findActiveHolderIdsInheriting(roleId: string): Promise<ReadonlyArray<string>>;
  /** El rol y sus ancestros vivos por parent_role_id: lo que aporta al heredarlo. */
  findLineage(roleId: string): Promise<ReadonlyArray<Role>>;
  /** Permisos directos de los roles dados, sin repetir. */
  findPermissionsForRoles(roleIds: ReadonlyArray<string>): Promise<ReadonlyArray<Permission>>;
  countActiveChildren(parentRoleId: string): Promise<number>;
  /** Alcances de las asignaciones activas del usuario que alcanzan al rol (directa o por herencia). */
  findHolderScopesReachingRole(
    userId: string,
    roleId: string,
  ): Promise<ReadonlyArray<{ readonly scopeType: string; readonly scopeId: string | null }>>;
  countActiveAssignees(roleId: string): Promise<number>;
}
