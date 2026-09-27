import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { Role } from '../../auth/entities/role.entity.js';
import type { RolesRepository } from '../repositories/roles.repository.interface.js';
import type { PermissionsService } from './permissions.service.js';
import { RolePrivilegePolicy } from './role-privilege.policy.js';

const actor: AuthenticatedUser = {
  id: 'director-1',
  personId: 'person-1',
  username: 'director',
  roles: ['INTERNAL_CONTROL_DIRECTOR'],
  scopes: [{ type: 'GLOBAL', id: null }],
};

const role = (code: string, hierarchyLevel: number): Role => {
  const item = new Role();
  item.id = code;
  item.code = code;
  item.hierarchyLevel = hierarchyLevel;
  return item;
};

describe('RolePrivilegePolicy', () => {
  let policy: RolePrivilegePolicy;
  let rolesRepository: Pick<RolesRepository, 'findAllActive' | 'findRolesHeldBy'>;
  /** Roles vigentes en BD por usuario: la política ya no mira actor.roles (BE-09). */
  let held: Record<string, ReadonlyArray<Role>>;
  let permissionsService: Pick<PermissionsService, 'getEffectivePermissions'>;

  beforeEach(() => {
    held = {
      'director-1': [role('INTERNAL_CONTROL_DIRECTOR', 1)],
      'admin-1': [role('SUPER_ADMIN', 0)],
    };
    rolesRepository = {
      findAllActive: vi.fn().mockResolvedValue([
        role('SUPER_ADMIN', 0),
        role('INTERNAL_CONTROL_DIRECTOR', 1),
        role('AUDITOR', 2),
      ]),
      findRolesHeldBy: vi.fn(async (userId: string) => held[userId] ?? []),
    };
    permissionsService = {
      getEffectivePermissions: vi.fn().mockResolvedValue([
        { permissionCode: 'asset:read:global', userScopeType: 'GLOBAL', userScopeId: null },
      ]),
    };
    policy = new RolePrivilegePolicy(
      rolesRepository as RolesRepository,
      permissionsService as PermissionsService,
    );
  });

  it('impide editar un rol igual o superior', async () => {
    await expect(policy.assertCanAdminister(actor, role('SUPER_ADMIN', 0))).rejects.toMatchObject({
      code: ErrorCode.RolePrivilegeEscalation,
    });
    await expect(
      policy.assertCanAdminister(actor, role('INTERNAL_CONTROL_DIRECTOR', 1)),
    ).rejects.toMatchObject({ code: ErrorCode.RolePrivilegeEscalation });
    await expect(policy.assertCanAdminister(actor, role('AUDITOR', 2))).resolves.toBeUndefined();
  });

  it('lista roles asignables por debajo del actor', async () => {
    const director = role('INTERNAL_CONTROL_DIRECTOR', 1);
    director.isAssignable = true;
    const auditor = role('AUDITOR', 2);
    auditor.isAssignable = true;
    const superAdmin = role('SUPER_ADMIN', 0);
    superAdmin.isAssignable = false;
    vi.mocked(rolesRepository.findAllActive).mockResolvedValue([
      superAdmin,
      director,
      auditor,
    ]);
    const listed = await policy.listAssignableFor(actor);
    expect(listed.map((item) => item.code)).toEqual(['AUDITOR']);
  });

  it('solo el super admin reorganiza la jerarquía', async () => {
    const admin: AuthenticatedUser = { ...actor, id: 'admin-1', roles: ['SUPER_ADMIN'] };
    await expect(policy.assertCanReorganize(admin)).resolves.toBeUndefined();
    await expect(policy.assertCanReorganize(actor)).rejects.toMatchObject({
      code: ErrorCode.InsufficientPermissions,
    });
  });

  it('BE-09: el rango sale de la BD, no del token', async () => {
    // El token todavía dice SUPER_ADMIN, pero en BD ya no lo tiene: no reorganiza ni administra como tal.
    const stale: AuthenticatedUser = { ...actor, roles: ['SUPER_ADMIN'] };
    await expect(policy.isSuperAdmin(stale)).resolves.toBe(false);
    await expect(policy.assertCanReorganize(stale)).rejects.toMatchObject({
      code: ErrorCode.InsufficientPermissions,
    });
    // Sin roles vigentes no tiene rango alguno.
    held['director-1'] = [];
    await expect(policy.actorRank(actor)).rejects.toMatchObject({
      code: ErrorCode.InsufficientPermissions,
    });
  });

  describe('BE-07: administrar a otro usuario', () => {
    it('rechaza a un usuario de rango igual o superior', async () => {
      held['peer'] = [role('INTERNAL_CONTROL_DIRECTOR', 1)];
      held['boss'] = [role('AUDITOR', 2), role('SUPER_ADMIN', 0)];
      for (const target of ['peer', 'boss']) {
        await expect(policy.assertCanAdministerUser(actor, target)).rejects.toMatchObject({
          code: ErrorCode.RolePrivilegeEscalation,
        });
      }
    });

    it('permite a un usuario de rango inferior o sin roles vigentes', async () => {
      held['below'] = [role('AUDITOR', 2)];
      await expect(policy.assertCanAdministerUser(actor, 'below')).resolves.toBeUndefined();
      await expect(policy.assertCanAdministerUser(actor, 'nobody')).resolves.toBeUndefined();
    });

    it('SUPER_ADMIN administra a todos, también a otro SUPER_ADMIN', async () => {
      const admin: AuthenticatedUser = { ...actor, id: 'admin-1', roles: ['SUPER_ADMIN'] };
      held['other-admin'] = [role('SUPER_ADMIN', 0)];
      await expect(policy.assertCanAdministerUser(admin, 'other-admin')).resolves.toBeUndefined();
    });

    it('sobre sí mismo no aplica (cada acción tiene su propia regla)', async () => {
      await expect(policy.assertCanAdministerUser(actor, actor.id)).resolves.toBeUndefined();
    });
  });

  it('impide conceder un permiso que el actor no tiene', async () => {
    await expect(
      policy.assertCanGrant(actor, [{ code: 'role:manage:global' }]),
    ).rejects.toMatchObject({ code: ErrorCode.PermissionNotHeld });
    await expect(
      policy.assertCanGrant(actor, [{ code: 'asset:read:global' }]),
    ).resolves.toBeUndefined();
  });
});
