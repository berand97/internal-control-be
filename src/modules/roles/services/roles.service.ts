import { Inject, Injectable } from '@nestjs/common';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import {
  isRoleHierarchyCycle,
  isUniqueViolation,
} from '../../../common/exceptions/postgres-error.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import {
  AssignPermissionsDto,
  ReplacePermissionsDto,
} from '../dto/assign-permissions.dto.js';
import {
  CreatePermissionDto,
  UpdatePermissionDto,
} from '../dto/create-permission.dto.js';
import { CreateRoleDto } from '../dto/create-role.dto.js';
import { CreateSodRuleDto } from '../dto/create-sod-rule.dto.js';
import { UpdateRoleDto } from '../dto/update-role.dto.js';
import {
  groupPermissionsCatalog,
  type PermissionCatalogModuleDto,
} from '../dto/responses/permission-catalog.response.dto.js';
import { NavigationCatalogItemResponseDto } from '../dto/responses/navigation-catalog-item.response.dto.js';
import { PermissionResponseDto } from '../dto/responses/permission.response.dto.js';
import { RoleDetailResponseDto } from '../dto/responses/role-detail.response.dto.js';
import { RoleResponseDto } from '../dto/responses/role.response.dto.js';
import { SodRuleResponseDto } from '../dto/responses/sod-rule.response.dto.js';
import type { RolesRepository } from '../repositories/roles.repository.interface.js';
import { NavigationService } from '../../navigation/services/navigation.service.js';
import { PermissionsService } from './permissions.service.js';
import { descendantRoleIds } from './role-hierarchy.js';
import { RolePrivilegePolicy } from './role-privilege.policy.js';

const ROLE_ENTITY_TYPE = 'ROLE';

@Injectable()
export class RolesService {
  constructor(
    @Inject('RolesRepository')
    private readonly rolesRepository: RolesRepository,
    @Inject('AuditLogsRepository')
    private readonly auditLogsRepository: AuditLogsRepository,
    private readonly permissionsService: PermissionsService,
    private readonly navigationService: NavigationService,
    private readonly privilege: RolePrivilegePolicy,
  ) {}

  async list(): Promise<ReadonlyArray<RoleResponseDto>> {
    const roles = await this.rolesRepository.findAllActive();
    return roles.map(RoleResponseDto.from);
  }

  async getById(id: string): Promise<RoleDetailResponseDto> {
    const role = await this.requireRole(id);
    const [permissions, children, sodRules, catalog] = await Promise.all([
      this.rolesRepository.findPermissionsForRole(role.id),
      this.rolesRepository.findChildren(role.id),
      this.rolesRepository.findSodForRole(role.id),
      this.navigationService.listActiveDefinitions(),
    ]);
    return RoleDetailResponseDto.fromDetail(
      role,
      permissions,
      children,
      sodRules,
      catalog,
    );
  }

  async create(
    dto: CreateRoleDto,
    actor: AuthenticatedUser,
  ): Promise<RoleResponseDto> {
    const parent = dto.parentRoleId
      ? await this.requireRole(dto.parentRoleId)
      : null;
    if (dto.superiorRoleId !== undefined) {
      this.privilege.assertCanReorganize(actor);
    }
    const superior = dto.superiorRoleId
      ? await this.requireRole(dto.superiorRoleId)
      : await this.rolesRepository.findActiveByCode('SUPER_ADMIN');
    const hierarchyLevel = superior
      ? superior.hierarchyLevel + 1
      : (await this.privilege.actorRank(actor)) + 1;
    await this.privilege.assertCanCreateLevel(actor, hierarchyLevel);
    try {
      const permissions = await this.requirePermissions(dto.permissionIds ?? []);
      await this.privilege.assertCanGrant(actor, permissions);
      const permissionIds = permissions.map((permission) => permission.id);
      const role = await this.rolesRepository.insert({
        code: dto.code,
        name: dto.name,
        description: dto.description ?? null,
        parentRoleId: parent?.id ?? null,
        superiorRoleId: superior?.id ?? null,
        hierarchyLevel,
        isSystem: false,
        isAssignable: dto.isAssignable ?? true,
        maxConcurrentUsers: dto.maxConcurrentUsers ?? null,
      });
      if (permissionIds.length > 0) {
        await this.rolesRepository.replacePermissions(
          role.id,
          permissionIds,
          actor.id,
        );
      }
      await this.auditLogsRepository.record({
        action: AuditAction.RoleCreated,
        entityType: ROLE_ENTITY_TYPE,
        entityId: role.id,
        performedBy: actor.id,
        ipAddress: null,
        userAgent: null,
        changes: { code: role.code, permissionIds: [...permissionIds] },
      });
      return RoleResponseDto.from(role);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiException(ErrorCode.RoleCodeAlreadyExists);
      }
      if (isRoleHierarchyCycle(error)) {
        throw new ApiException(ErrorCode.InvalidState);
      }
      throw error;
    }
  }

  async update(
    id: string,
    dto: UpdateRoleDto,
    actor: AuthenticatedUser,
  ): Promise<RoleResponseDto> {
    const role = await this.requireRole(id);
    const reorganizing =
      dto.parentRoleId !== undefined || dto.superiorRoleId !== undefined;
    if (reorganizing) {
      this.privilege.assertCanReorganize(actor);
      if (role.code === 'SUPER_ADMIN') {
        throw new ApiException(ErrorCode.RoleSystemImmutable);
      }
    }

    let parentRoleId = role.parentRoleId;
    if (dto.parentRoleId !== undefined) {
      if (dto.parentRoleId === role.id) {
        throw new ApiException(ErrorCode.InvalidState);
      }
      if (dto.parentRoleId === null) {
        parentRoleId = null;
      } else {
        const parent = await this.requireRole(dto.parentRoleId);
        parentRoleId = parent.id;
      }
    }

    let superiorRoleId = role.superiorRoleId;
    let hierarchyLevel = role.hierarchyLevel;
    let descendantLevels: ReadonlyArray<{ id: string; hierarchyLevel: number }> =
      [];
    if (dto.superiorRoleId !== undefined) {
      if (dto.superiorRoleId === role.id) {
        throw new ApiException(ErrorCode.InvalidState);
      }
      const all = await this.rolesRepository.findAllActive();
      if (descendantRoleIds(role.id, all).has(dto.superiorRoleId)) {
        throw new ApiException(ErrorCode.InvalidState);
      }
      const superior = await this.requireRole(dto.superiorRoleId);
      superiorRoleId = superior.id;
      hierarchyLevel = superior.hierarchyLevel + 1;
      const delta = hierarchyLevel - role.hierarchyLevel;
      if (delta !== 0) {
        descendantLevels = [...descendantRoleIds(role.id, all)].flatMap((id) => {
          const child = all.find((item) => item.id === id);
          return child === undefined
            ? []
            : [{ id, hierarchyLevel: child.hierarchyLevel + delta }];
        });
      }
    }

    try {
      await this.rolesRepository.update(role.id, {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description }
          : {}),
        ...(dto.parentRoleId !== undefined ? { parentRoleId } : {}),
        ...(dto.superiorRoleId !== undefined
          ? { superiorRoleId, hierarchyLevel }
          : {}),
      });
      for (const child of descendantLevels) {
        await this.rolesRepository.update(child.id, {
          hierarchyLevel: child.hierarchyLevel,
        });
      }
    } catch (error) {
      if (isRoleHierarchyCycle(error)) {
        throw new ApiException(ErrorCode.InvalidState);
      }
      throw error;
    }

    await this.invalidateAssignees(role.id);
    await this.auditLogsRepository.record({
      action: AuditAction.RoleUpdated,
      entityType: ROLE_ENTITY_TYPE,
      entityId: role.id,
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
      changes: { ...dto },
    });
    const updated = await this.requireRole(id);
    return RoleResponseDto.from(updated);
  }

  async remove(id: string, actor: AuthenticatedUser): Promise<null> {
    const role = await this.requireRole(id);
    await this.privilege.assertCanAdminister(actor, role);
    if (role.isSystem) {
      throw new ApiException(ErrorCode.RoleSystemImmutable);
    }
    const assignees = await this.rolesRepository.countActiveAssignees(role.id);
    if (assignees > 0) {
      throw new ApiException(ErrorCode.RoleHasAssignedUsers);
    }
    await this.rolesRepository.softDelete(role.id, new Date());
    await this.auditLogsRepository.record({
      action: AuditAction.RoleDeleted,
      entityType: ROLE_ENTITY_TYPE,
      entityId: role.id,
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
      changes: { code: role.code },
    });
    return null;
  }

  async listPermissions(): Promise<ReadonlyArray<PermissionResponseDto>> {
    const permissions = await this.rolesRepository.listPermissions();
    return permissions.map(PermissionResponseDto.from);
  }

  async listPermissionCatalog(): Promise<
    ReadonlyArray<PermissionCatalogModuleDto>
  > {
    const permissions = await this.rolesRepository.listPermissions();
    return groupPermissionsCatalog(permissions);
  }

  async createPermission(
    dto: CreatePermissionDto,
  ): Promise<PermissionResponseDto> {
    const scope = dto.scopeLevel.toLowerCase();
    const code = `${dto.resourceType}:${dto.action}:${scope}`;
    const existing = await this.rolesRepository.listPermissions();
    const sibling = existing.find((item) => item.resourceType === dto.resourceType);
    const resourceLabel = dto.resourceLabel?.trim() || sibling?.resourceLabel;
    if (resourceLabel === undefined || resourceLabel.length === 0) {
      throw new ApiException(ErrorCode.ValidationFailed);
    }
    try {
      const permission = await this.rolesRepository.insertPermission({
        code,
        module: dto.module,
        resourceType: dto.resourceType,
        resourceLabel,
        action: dto.action,
        scopeLevel: dto.scopeLevel,
        description: dto.description ?? null,
        isSystem: false,
      });
      return PermissionResponseDto.from(permission);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiException(ErrorCode.PermissionCodeAlreadyExists);
      }
      throw error;
    }
  }

  async updatePermission(
    id: string,
    dto: UpdatePermissionDto,
  ): Promise<PermissionResponseDto> {
    const [permission] = await this.rolesRepository.findPermissionsByIds([id]);
    if (!permission) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    if (dto.description !== undefined) {
      await this.rolesRepository.updatePermission(id, {
        description: dto.description,
      });
      permission.description = dto.description;
    }
    return PermissionResponseDto.from(permission);
  }

  async deletePermission(id: string): Promise<null> {
    const [permission] = await this.rolesRepository.findPermissionsByIds([id]);
    if (!permission) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    if (permission.isSystem) {
      throw new ApiException(ErrorCode.PermissionSystemImmutable);
    }
    const assigned =
      await this.rolesRepository.countPermissionAssignments(id);
    if (assigned > 0) {
      throw new ApiException(ErrorCode.PermissionInUse);
    }
    const removed = await this.rolesRepository.deletePermission(id);
    if (!removed) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return null;
  }

  async listNavigationCatalog(): Promise<
    ReadonlyArray<NavigationCatalogItemResponseDto>
  > {
    const catalog = await this.navigationService.listActiveDefinitions();
    return catalog.map(NavigationCatalogItemResponseDto.from);
  }

  async assignPermissions(
    roleId: string,
    dto: AssignPermissionsDto,
    actor: AuthenticatedUser,
  ): Promise<RoleDetailResponseDto> {
    const role = await this.requireRole(roleId);
    await this.privilege.assertCanAdminister(actor, role);
    const permissions = await this.requirePermissions(dto.permissionIds);
    await this.privilege.assertCanGrant(actor, permissions);
    const permissionIds = permissions.map((permission) => permission.id);
    for (const permissionId of permissionIds) {
      await this.rolesRepository.assignPermission(
        role.id,
        permissionId,
        actor.id,
      );
    }
    await this.invalidateAssignees(role.id);
    await this.auditLogsRepository.record({
      action: AuditAction.RolePermsSet,
      entityType: ROLE_ENTITY_TYPE,
      entityId: role.id,
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
      changes: { addedPermissionIds: [...permissionIds] },
    });
    return this.getById(role.id);
  }

  async replacePermissions(
    roleId: string,
    dto: ReplacePermissionsDto,
    actor: AuthenticatedUser,
  ): Promise<RoleDetailResponseDto> {
    const role = await this.requireRole(roleId);
    await this.privilege.assertCanAdminister(actor, role);
    const permissions = await this.requirePermissions(dto.permissionIds);
    const current = await this.rolesRepository.findPermissionsForRole(role.id);
    const currentIds = new Set(current.map((permission) => permission.id));
    const added = permissions.filter((permission) => !currentIds.has(permission.id));
    await this.privilege.assertCanGrant(actor, added);
    const permissionIds = permissions.map((permission) => permission.id);
    await this.rolesRepository.replacePermissions(
      role.id,
      permissionIds,
      actor.id,
    );
    await this.invalidateAssignees(role.id);
    await this.auditLogsRepository.record({
      action: AuditAction.RolePermsSet,
      entityType: ROLE_ENTITY_TYPE,
      entityId: role.id,
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
      changes: { permissionIds: [...permissionIds] },
    });
    return this.getById(role.id);
  }

  async removePermission(
    roleId: string,
    permissionId: string,
    actor: AuthenticatedUser,
  ): Promise<null> {
    const role = await this.requireRole(roleId);
    await this.privilege.assertCanAdminister(actor, role);
    const removed = await this.rolesRepository.removePermission(
      role.id,
      permissionId,
    );
    if (!removed) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    await this.invalidateAssignees(role.id);
    await this.auditLogsRepository.record({
      action: AuditAction.RolePermsSet,
      entityType: ROLE_ENTITY_TYPE,
      entityId: role.id,
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
      changes: { removedPermissionId: permissionId },
    });
    return null;
  }

  async createSodRule(
    dto: CreateSodRuleDto,
    actor: AuthenticatedUser,
  ): Promise<SodRuleResponseDto> {
    if (dto.roleAId === dto.roleBId) {
      throw new ApiException(ErrorCode.InvalidState);
    }
    await this.requireRole(dto.roleAId);
    await this.requireRole(dto.roleBId);
    try {
      const rule = await this.rolesRepository.insertSod({
        roleAId: dto.roleAId,
        roleBId: dto.roleBId,
        constraintType: dto.constraintType,
        reason: dto.reason,
      });
      await this.auditLogsRepository.record({
        action: AuditAction.SodCreated,
        entityType: ROLE_ENTITY_TYPE,
        entityId: rule.id,
        performedBy: actor.id,
        ipAddress: null,
        userAgent: null,
        changes: { ...dto },
      });
      return SodRuleResponseDto.from(rule);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiException(ErrorCode.InvalidState);
      }
      throw error;
    }
  }

  private async requireRole(id: string) {
    const role = await this.rolesRepository.findActiveById(id);
    if (!role) {
      throw new ApiException(ErrorCode.RoleNotFound);
    }
    return role;
  }

  private async requirePermissions(
    ids: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<{ readonly id: string; readonly code: string }>> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) {
      return [];
    }
    const permissions =
      await this.rolesRepository.findPermissionsByIds(uniqueIds);
    if (permissions.length !== uniqueIds.length) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return permissions;
  }

  private async invalidateAssignees(roleId: string): Promise<void> {
    const userIds = await this.rolesRepository.findActiveAssigneeIds(roleId);
    this.permissionsService.invalidateMany(userIds);
  }
}
