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

  /**
   * Roles vigentes del actor leídos de la BD en cada decisión (BE-09): un rol revocado deja de contar de inmediato,
   * aunque el access token todavía lo liste en `roles`.
   */
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

  /**
   * Administración en cascada sobre OTRO usuario (BE-07): revocarle roles, desactivarlo o reactivarlo, editarlo,
   * reenviarle la invitación o restablecer su MFA exige que su rol de mayor rango (menor hierarchy_level) quede por
   * debajo del rango del actor. SUPER_ADMIN administra a todos. Un usuario sin roles vigentes lo administra
   * cualquiera con rango. Las acciones sobre uno mismo no pasan por aquí: cada una tiene su propia regla (p. ej. el
   * autorrestablecimiento de MFA está prohibido; revocarse un rol propio solo reduce privilegios).
   */
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

  /**
   * Heredar de un rol (parent_role_id) equivale a otorgar todo lo que aporta: el padre y cada ancestro suyo deben ser
   * administrables por el actor (nivel mayor al propio) y el actor debe tener, efectivamente, cada permiso del
   * linaje. La separación de funciones sobre roles efectivos la hace cumplir la BD (fn_check_role_inheritance_sod).
   */
  async assertCanInheritFrom(
    actor: AuthenticatedUser,
    parent: Pick<Role, 'id' | 'hierarchyLevel'>,
    /** Rol existente que pasaría a heredar: si el actor lo tiene, no puede ampliarse con la herencia. */
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
    await this.assertCanGrant(actor, inherited);
    if (inheritingRoleId !== undefined) {
      await this.assertDoesNotWidenOwn(actor, inheritingRoleId, inherited);
    }
  }

  /**
   * Superior por defecto de un rol nuevo: el SUPER_ADMIN crea bajo SUPER_ADMIN (como antes); cualquier otro actor,
   * bajo su propio rol de mayor rango, de modo que el rol nuevo queda un nivel por debajo de él (cascada).
   */
  async defaultSuperiorFor(actor: AuthenticatedUser): Promise<Role | null> {
    if (await this.isSuperAdmin(actor)) {
      return this.rolesRepository.findActiveByCode('SUPER_ADMIN');
    }
    const rank = await this.actorRank(actor);
    const held = await this.heldRoles(actor);
    return held.find((role) => role.hierarchyLevel === rank) ?? null;
  }

  /**
   * Nadie se agrega permisos a sí mismo, tampoco SUPER_ADMIN: si el actor tiene el rol (directo o heredado, con una
   * asignación vigente o que empieza en el futuro, con cualquier alcance), no puede agregarle permisos, ni siquiera
   * los que ya tiene por otro rol; lo hace otro administrador. Quitar permisos de un rol propio no pasa por aquí.
   */
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

  /**
   * Otorgar permisos a un rol (crearlo con permisos, agregarle o reemplazar su set). SUPER_ADMIN es administración
   * pura: otorga cualquier permiso aunque no lo tenga (no opera). Los demás siguen la cascada: solo lo que tienen.
   * La herencia (parent_role_id) no pasa por aquí: sigue exigiendo tener cada permiso del linaje
   * (assertCanInheritFrom), también a SUPER_ADMIN.
   */
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
