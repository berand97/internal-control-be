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
  let rolesRepository: Pick<RolesRepository, 'findAllActive'>;
  let permissionsService: Pick<PermissionsService, 'getEffectivePermissions'>;

  beforeEach(() => {
    rolesRepository = {
      findAllActive: vi.fn().mockResolvedValue([
        role('SUPER_ADMIN', 0),
        role('INTERNAL_CONTROL_DIRECTOR', 1),
        role('AUDITOR', 2),
      ]),
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

  it('solo el super admin reorganiza la jerarquía', () => {
    const admin: AuthenticatedUser = { ...actor, roles: ['SUPER_ADMIN'] };
    expect(() => policy.assertCanReorganize(admin)).not.toThrow();
    try {
      policy.assertCanReorganize(actor);
      throw new Error('expected reorganize to fail');
    } catch (err) {
      expect(err).toMatchObject({ code: ErrorCode.InsufficientPermissions });
    }
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
