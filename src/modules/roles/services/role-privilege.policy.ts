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

  isSuperAdmin(actor: AuthenticatedUser): boolean {
    return actor.roles.includes('SUPER_ADMIN');
  }

  assertCanReorganize(actor: AuthenticatedUser): void {
    if (!this.isSuperAdmin(actor)) {
      throw new ApiException(ErrorCode.InsufficientPermissions);
    }
  }

  async actorRank(actor: AuthenticatedUser): Promise<number> {
    const roles = await this.rolesRepository.findAllActive();
    const held = roles.filter((role) => actor.roles.includes(role.code));
    if (held.length === 0) {
      throw new ApiException(ErrorCode.InsufficientPermissions);
    }
    return Math.min(...held.map((role) => role.hierarchyLevel));
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
