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

  /**
   * Heredar de un rol (parent_role_id) equivale a otorgar todo lo que aporta: el padre y cada ancestro suyo deben ser
   * administrables por el actor (nivel mayor al propio) y el actor debe tener, efectivamente, cada permiso del
   * linaje. La separación de funciones sobre roles efectivos la hace cumplir la BD (fn_check_role_inheritance_sod).
   */
  async assertCanInheritFrom(
    actor: AuthenticatedUser,
    parent: Pick<Role, 'id' | 'hierarchyLevel'>,
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
    await this.assertCanGrant(actor, inherited);
  }

  /**
   * Superior por defecto de un rol nuevo: el SUPER_ADMIN crea bajo SUPER_ADMIN (como antes); cualquier otro actor,
   * bajo su propio rol de mayor rango, de modo que el rol nuevo queda un nivel por debajo de él (cascada).
   */
  async defaultSuperiorFor(actor: AuthenticatedUser): Promise<Role | null> {
    if (this.isSuperAdmin(actor)) {
      return this.rolesRepository.findActiveByCode('SUPER_ADMIN');
    }
    const rank = await this.actorRank(actor);
    const roles = await this.rolesRepository.findAllActive();
    return (
      roles.find(
        (role) => actor.roles.includes(role.code) && role.hierarchyLevel === rank,
      ) ?? null
    );
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
