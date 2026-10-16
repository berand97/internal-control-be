import { Inject, Injectable } from '@nestjs/common';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import type { Role } from '../../auth/entities/role.entity.js';
import type { Permission } from '../entities/permission.entity.js';
import type { RolesRepository } from '../repositories/roles.repository.interface.js';
import { PermissionsService } from './permissions.service.js';

@Injectable()
export class RolePrivilegePolicy {
  constructor(
    @Inject('RolesRepository')
    private readonly rolesRepository: RolesRepository,
    private readonly permissionsService: PermissionsService,
  ) {}

  private heldRoles(actor: AuthenticatedUser): Promise<ReadonlyArray<Role>> {
    return this.rolesRepository.findRolesHeldBy(actor.id);
  }

  async isSuperAdmin(actor: AuthenticatedUser): Promise<boolean> {
    const held = await this.heldRoles(actor);
    return held.some((role) => role.code === 'SUPER_ADMIN');
  }

  async assertCanReorganize(actor: AuthenticatedUser): Promise<void> {
    if (!(await this.isSuperAdmin(actor))) {
      throw new ApiException(ErrorCode.InsufficientPermissions);
    }
  }

  async actorRank(actor: AuthenticatedUser): Promise<number> {
    const held = await this.heldRoles(actor);
    if (held.length === 0) {
      throw new ApiException(ErrorCode.InsufficientPermissions);
    }
    return Math.min(...held.map((role) => role.hierarchyLevel));
  }

  async assertCanAdministerUser(
    actor: AuthenticatedUser,
    targetUserId: string,
  ): Promise<void> {
    if (targetUserId === actor.id) {
      return;
    }
    const held = await this.heldRoles(actor);
    if (held.some((role) => role.code === 'SUPER_ADMIN')) {
      return;
    }
    if (held.length === 0) {
      throw new ApiException(ErrorCode.InsufficientPermissions);
    }
    const rank = Math.min(...held.map((role) => role.hierarchyLevel));
    const target = await this.rolesRepository.findRolesHeldBy(targetUserId);
    if (target.some((role) => role.hierarchyLevel <= rank)) {
      throw new ApiException(ErrorCode.RolePrivilegeEscalation);
    }
  }

  async listAssignableFor(actor: AuthenticatedUser): Promise<ReadonlyArray<Role>> {
    const rank = await this.actorRank(actor);
    const roles = await this.rolesRepository.findAllActive();
    return roles.filter(
      (role) => role.isAssignable === true && role.hierarchyLevel > rank,
    );
  }

  async assertCanAdminister(
    actor: AuthenticatedUser,
    target: Pick<Role, 'hierarchyLevel'>,
  ): Promise<void> {
    const rank = await this.actorRank(actor);
    if (target.hierarchyLevel <= rank) {
      throw new ApiException(ErrorCode.RolePrivilegeEscalation);
    }
  }

  async assertCanCreateLevel(
    actor: AuthenticatedUser,
    hierarchyLevel: number,
  ): Promise<void> {
    const rank = await this.actorRank(actor);
    if (hierarchyLevel <= rank) {
      throw new ApiException(ErrorCode.RolePrivilegeEscalation);
    }
  }

  async assertCanInheritFrom(
    actor: AuthenticatedUser,
    parent: Pick<Role, 'id' | 'hierarchyLevel'>,
    inheritingRoleId?: string,
  ): Promise<void> {
    await this.assertCanAdminister(actor, parent);
    const lineage = await this.rolesRepository.findLineage(parent.id);
    const rank = await this.actorRank(actor);
    if (lineage.some((role) => role.hierarchyLevel <= rank)) {
      throw new ApiException(ErrorCode.RolePrivilegeEscalation);
    }
    const inherited = await this.rolesRepository.findPermissionsForRoles(
      lineage.map((role) => role.id),
    );
    await this.assertCanGrantPermissions(actor, inherited);
    if (inheritingRoleId !== undefined) {
      await this.assertDoesNotWidenOwn(actor, inheritingRoleId, inherited);
    }
  }

  async defaultSuperiorFor(actor: AuthenticatedUser): Promise<Role | null> {
    if (await this.isSuperAdmin(actor)) {
      return this.rolesRepository.findActiveByCode('SUPER_ADMIN');
    }
    const rank = await this.actorRank(actor);
    const held = await this.heldRoles(actor);
    return held.find((role) => role.hierarchyLevel === rank) ?? null;
  }

  async assertDoesNotWidenOwn(
    actor: AuthenticatedUser,
    roleId: string,
    permissions: ReadonlyArray<Pick<Permission, 'code'>>,
  ): Promise<void> {
    if (permissions.length === 0) {
      return;
    }
    const scopes = await this.rolesRepository.findHolderScopesReachingRole(
      actor.id,
      roleId,
    );
    if (scopes.length > 0) {
      throw new ApiException(ErrorCode.RoleSelfAssignmentForbidden);
    }
  }

  async assertCanGrantPermissions(
    actor: AuthenticatedUser,
    permissions: ReadonlyArray<Pick<Permission, 'code'>>,
  ): Promise<void> {
    if (permissions.length === 0 || (await this.isSuperAdmin(actor))) {
      return;
    }
    await this.assertCanGrant(actor, permissions);
  }

  async assertCanGrant(
    actor: AuthenticatedUser,
    permissions: ReadonlyArray<Pick<Permission, 'code'>>,
  ): Promise<void> {
    if (permissions.length === 0) {
      return;
    }
    const held = new Set(
      (await this.permissionsService.getEffectivePermissions(actor.id)).map(
        (item) => item.permissionCode,
      ),
    );
    if (permissions.some((permission) => !held.has(permission.code))) {
      throw new ApiException(ErrorCode.PermissionNotHeld);
    }
  }
}
