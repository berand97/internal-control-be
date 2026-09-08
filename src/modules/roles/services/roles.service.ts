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
import { CreateRoleDto } from '../dto/create-role.dto.js';
import { CreateSodRuleDto } from '../dto/create-sod-rule.dto.js';
import { UpdateRoleDto } from '../dto/update-role.dto.js';
import {
  groupPermissionsCatalog,
  type PermissionCatalogModuleDto,
} from '../dto/responses/permission-catalog.response.dto.js';
import { PermissionResponseDto } from '../dto/responses/permission.response.dto.js';
import { RoleDetailResponseDto } from '../dto/responses/role-detail.response.dto.js';
import { RoleResponseDto } from '../dto/responses/role.response.dto.js';
import { SodRuleResponseDto } from '../dto/responses/sod-rule.response.dto.js';
import type { RolesRepository } from '../repositories/roles.repository.interface.js';
import { PermissionsService } from './permissions.service.js';

const ROLE_ENTITY_TYPE = 'ROLE';

@Injectable()
export class RolesService {
  constructor(
    @Inject('RolesRepository')
    private readonly rolesRepository: RolesRepository,
    @Inject('AuditLogsRepository')
    private readonly auditLogsRepository: AuditLogsRepository,
    private readonly permissionsService: PermissionsService,
  ) {}

  async list(): Promise<ReadonlyArray<RoleResponseDto>> {
    const roles = await this.rolesRepository.findAllActive();
    return roles.map(RoleResponseDto.from);
  }

  async getById(id: string): Promise<RoleDetailResponseDto> {
    const role = await this.requireRole(id);
    const [permissions, children, sodRules] = await Promise.all([
      this.rolesRepository.findPermissionsForRole(role.id),
      this.rolesRepository.findChildren(role.id),
      this.rolesRepository.findSodForRole(role.id),
    ]);
    return RoleDetailResponseDto.fromDetail(
      role,
      permissions,
      children,
      sodRules,
    );
  }

  async create(
    dto: CreateRoleDto,
    actor: AuthenticatedUser,
  ): Promise<RoleResponseDto> {
    const parent = dto.parentRoleId
      ? await this.requireRole(dto.parentRoleId)
      : null;
    try {
      const permissionIds = await this.requirePermissionIds(
        dto.permissionIds ?? [],
      );
      const role = await this.rolesRepository.insert({
        code: dto.code,
        name: dto.name,
        description: dto.description ?? null,
        parentRoleId: parent?.id ?? null,
        hierarchyLevel: parent ? parent.hierarchyLevel + 1 : 0,
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
    if (role.isSystem && dto.name !== undefined && dto.name !== role.name) {
      throw new ApiException(ErrorCode.RoleSystemImmutable);
    }

    let hierarchyLevel = role.hierarchyLevel;
    let parentRoleId = role.parentRoleId;
    if (dto.parentRoleId !== undefined) {
      if (dto.parentRoleId === role.id) {
        throw new ApiException(ErrorCode.InvalidState);
      }
      const parent = await this.requireRole(dto.parentRoleId);
      parentRoleId = parent.id;
      hierarchyLevel = parent.hierarchyLevel + 1;
    }

    try {
      await this.rolesRepository.update(role.id, {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description }
          : {}),
        ...(dto.parentRoleId !== undefined
          ? { parentRoleId, hierarchyLevel }
          : {}),
      });
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

  async assignPermissions(
    roleId: string,
    dto: AssignPermissionsDto,
    actor: AuthenticatedUser,
  ): Promise<RoleDetailResponseDto> {
    const role = await this.requireRole(roleId);
    const permissionIds = await this.requirePermissionIds(dto.permissionIds);
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
    const permissionIds = await this.requirePermissionIds(dto.permissionIds);
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

  private async requirePermissionIds(
    ids: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<string>> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) {
      return uniqueIds;
    }
    const permissions =
      await this.rolesRepository.findPermissionsByIds(uniqueIds);
    if (permissions.length !== uniqueIds.length) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return uniqueIds;
  }

  private async invalidateAssignees(roleId: string): Promise<void> {
    const userIds = await this.rolesRepository.findActiveAssigneeIds(roleId);
    this.permissionsService.invalidateMany(userIds);
  }
}
