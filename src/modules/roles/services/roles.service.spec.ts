import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { Role } from '../../auth/entities/role.entity.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import type { RolesRepository } from '../repositories/roles.repository.interface.js';
import { PermissionsService } from './permissions.service.js';
import { RolePrivilegePolicy } from './role-privilege.policy.js';
import { RolesService } from './roles.service.js';

const ORIGIN = { ipAddress: null, userAgent: null };

const actor: AuthenticatedUser = {
  id: 'admin-1',
  personId: 'person-1',
  username: 'admin',
  roles: ['SUPER_ADMIN'],
  scopes: [{ type: 'GLOBAL', id: null }],
};

const customRole = (): Role => {
  const role = new Role();
  role.id = 'role-1';
  role.code = 'ASSET_COORDINATOR';
  role.name = 'Coordinador';
  role.description = null;
  role.parentRoleId = null;
  role.superiorRoleId = 'admin-role';
  role.hierarchyLevel = 1;
  role.isSystem = false;
  role.isAssignable = true;
  role.maxConcurrentUsers = null;
  role.createdAt = new Date();
  role.updatedAt = new Date();
  role.deletedAt = null;
  return role;
};

const systemRole = (): Role => {
  const role = customRole();
  role.id = 'sys-1';
  role.code = 'SUPER_ADMIN';
  role.isSystem = true;
  return role;
};

describe('RolesService', () => {
  let rolesRepository: RolesRepository;
  let auditLogsRepository: AuditLogsRepository;
  let permissionsService: Pick<
    PermissionsService,
    'invalidateMany' | 'getEffectivePermissions'
  >;
  let service: RolesService;

  const adminRole = (): Role => {
    const role = systemRole();
    role.id = 'admin-role';
    role.code = 'SUPER_ADMIN';
    role.superiorRoleId = null;
    role.hierarchyLevel = 0;
    return role;
  };

  beforeEach(() => {
    rolesRepository = {
      findAllActive: vi.fn(),
      findActiveById: vi.fn(),
      findActiveByCode: vi.fn(),
      // Roles vigentes en BD por usuario (BE-09: la política ya no lee actor.roles del JWT).
      findRolesHeldBy: vi.fn(async (userId: string) => {
        const held: Record<string, ReadonlyArray<string>> = {
          'admin-1': ['SUPER_ADMIN'],
          'director-1': ['INTERNAL_CONTROL_DIRECTOR'],
        };
        const all = await rolesRepository.findAllActive();
        return all.filter((role) => (held[userId] ?? []).includes(role.code));
      }),
      findChildren: vi.fn().mockResolvedValue([]),
      insert: vi.fn(),
      update: vi.fn(),
      softDelete: vi.fn(),
      listPermissions: vi.fn(),
      findPermissionsByIds: vi.fn(),
      findPermissionsForRole: vi.fn().mockResolvedValue([]),
      assignPermission: vi.fn(),
      replacePermissions: vi.fn(),
      removePermission: vi.fn(),
      findSodForRole: vi.fn().mockResolvedValue([]),
      insertSod: vi.fn(),
      findActiveHolderIdsInheriting: vi.fn().mockResolvedValue([]),
      findLineage: vi.fn().mockResolvedValue([]),
      findPermissionsForRoles: vi.fn().mockResolvedValue([]),
      countActiveChildren: vi.fn().mockResolvedValue(0),
      findHolderScopesReachingRole: vi.fn().mockResolvedValue([]),
      countActiveAssignees: vi.fn().mockResolvedValue(0),
      insertPermission: vi.fn(),
      updatePermission: vi.fn(),
      deletePermission: vi.fn(),
      countPermissionAssignments: vi.fn().mockResolvedValue(0),
    };
    auditLogsRepository = {
      record: vi.fn().mockResolvedValue(undefined),
      findLastLogins: vi.fn(),
    };
    permissionsService = {
      invalidateMany: vi.fn(),
      getEffectivePermissions: vi.fn().mockResolvedValue([
        {
          permissionCode: 'asset:read:global',
          userScopeType: 'GLOBAL',
          userScopeId: null,
        },
      ]),
    };
    vi.mocked(rolesRepository.findAllActive).mockResolvedValue([
      adminRole(),
      customRole(),
    ]);
    vi.mocked(rolesRepository.findActiveByCode).mockImplementation((code) =>
      Promise.resolve(code === 'SUPER_ADMIN' ? adminRole() : null),
    );
    service = new RolesService(
      rolesRepository,
      auditLogsRepository,
      permissionsService as PermissionsService,
      {
        listActiveDefinitions: vi.fn().mockResolvedValue([]),
      } as never,
      new RolePrivilegePolicy(
        rolesRepository,
        permissionsService as PermissionsService,
      ),
    );
  });

  it('crea un rol no sistema', async () => {
    const created = customRole();
    vi.mocked(rolesRepository.insert).mockResolvedValue(created);
    const result = await service.create(
      { reason: 'Motivo de prueba', code: 'ASSET_COORDINATOR', name: 'Coordinador' },
      actor,
      ORIGIN,
    );
    expect(result.code).toBe('ASSET_COORDINATOR');
    expect(rolesRepository.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        isSystem: false,
        superiorRoleId: 'admin-role',
        hierarchyLevel: 1,
      }),
    );
  });

  it('permite cambiar el nombre de un rol de sistema inferior y conserva el código', async () => {
    const current = systemRole();
    current.id = 'dir-1';
    current.code = 'INTERNAL_CONTROL_DIRECTOR';
    current.hierarchyLevel = 1;
    const renamed = systemRole();
    renamed.id = 'dir-1';
    renamed.code = 'INTERNAL_CONTROL_DIRECTOR';
    renamed.hierarchyLevel = 1;
    renamed.name = 'Dirección';
    vi.mocked(rolesRepository.findActiveById)
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(renamed);
    const result = await service.update('dir-1', { reason: 'Motivo de prueba', name: 'Dirección' }, actor, ORIGIN);
    expect(rolesRepository.update).toHaveBeenCalledWith(
      'dir-1',
      expect.objectContaining({ name: 'Dirección' }),
    );
    expect(result.name).toBe('Dirección');
    expect(result.code).toBe('INTERNAL_CONTROL_DIRECTOR');
  });

  it('permite cambiar el nombre de un rol del mismo nivel', async () => {
    const current = adminRole();
    const renamed = adminRole();
    renamed.name = 'Super Admin';
    vi.mocked(rolesRepository.findActiveById)
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(renamed);
    const result = await service.update('admin-role', { reason: 'Motivo de prueba', name: 'Super Admin' }, actor, ORIGIN);
    expect(rolesRepository.update).toHaveBeenCalledWith(
      'admin-role',
      expect.objectContaining({ name: 'Super Admin' }),
    );
    expect(result.name).toBe('Super Admin');
  });

  it('no permite editar un rol igual o superior', async () => {
    vi.mocked(rolesRepository.findActiveById).mockResolvedValue(adminRole());
    await expect(
      service.replacePermissions('admin-role', { reason: 'Motivo de prueba', permissionIds: [] }, actor, ORIGIN),
    ).rejects.toMatchObject({ code: ErrorCode.RolePrivilegeEscalation });
    expect(rolesRepository.replacePermissions).not.toHaveBeenCalled();
  });

  it('SUPER_ADMIN otorga un permiso aunque no lo tenga (administración pura)', async () => {
    vi.mocked(rolesRepository.findActiveById).mockResolvedValue(customRole());
    vi.mocked(rolesRepository.findPermissionsByIds).mockResolvedValue([
      { id: 'perm-admin', code: 'role:manage:global' } as never,
    ]);
    await expect(
      service.replacePermissions(
        'role-1',
        { reason: 'Motivo de prueba', permissionIds: ['perm-admin'] },
        actor,
        ORIGIN,
      ),
    ).resolves.toBeDefined();
    expect(rolesRepository.replacePermissions).toHaveBeenCalledWith('role-1', ['perm-admin'], actor.id);
    expect(auditLogsRepository.record).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: expect.objectContaining({
          addedPermissionCodes: ['role:manage:global'],
          removedPermissionCodes: [],
          reason: 'Motivo de prueba',
        }),
      }),
    );
  });

  it('no elimina un rol con usuarios asignados', async () => {
    vi.mocked(rolesRepository.findActiveById).mockResolvedValue(customRole());
    vi.mocked(rolesRepository.countActiveAssignees).mockResolvedValue(2);
    await expect(service.remove('role-1', actor)).rejects.toBeInstanceOf(
      ApiException,
    );
    await expect(service.remove('role-1', actor)).rejects.toMatchObject({
      code: ErrorCode.RoleHasAssignedUsers,
    });
  });

  it('no elimina un rol de sistema', async () => {
    const juniorSystem = systemRole();
    juniorSystem.code = 'INTERNAL_CONTROL_DIRECTOR';
    juniorSystem.hierarchyLevel = 1;
    vi.mocked(rolesRepository.findActiveById).mockResolvedValue(juniorSystem);
    await expect(service.remove('sys-1', actor)).rejects.toMatchObject({
      code: ErrorCode.RoleSystemImmutable,
    });
  });

  it('calcula jerarquía a partir del padre', async () => {
    const parent = systemRole();
    parent.id = 'parent-1';
    parent.hierarchyLevel = 2;
    vi.mocked(rolesRepository.findActiveById).mockResolvedValue(parent);
    vi.mocked(rolesRepository.insert).mockResolvedValue(customRole());
    await service.create(
      {
        reason: 'Motivo de prueba',
        code: 'ASSET_COORDINATOR',
        name: 'Coordinador',
        parentRoleId: 'parent-1',
      },
      actor,
      ORIGIN,
    );
    expect(rolesRepository.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        parentRoleId: 'parent-1',
        superiorRoleId: 'admin-role',
        hierarchyLevel: 1,
      }),
    );
  });

  it('permite al super admin mover un rol debajo de otro', async () => {
    const current = customRole();
    current.superiorRoleId = null;
    const superior = adminRole();
    const moved = customRole();
    moved.superiorRoleId = 'admin-role';
    moved.hierarchyLevel = 1;
    vi.mocked(rolesRepository.findActiveById)
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(superior)
      .mockResolvedValueOnce(moved);
    await service.update('role-1', { reason: 'Motivo de prueba', superiorRoleId: 'admin-role' }, actor, ORIGIN);
    expect(rolesRepository.update).toHaveBeenCalledWith('role-1', {
      superiorRoleId: 'admin-role',
      hierarchyLevel: 1,
    });
  });

  it('permite al super admin cambiar el padre sin recalcular el nivel', async () => {
    const current = customRole();
    const parent = systemRole();
    parent.id = 'parent-1';
    parent.code = 'VIEWER';
    parent.hierarchyLevel = 3;
    const updated = customRole();
    updated.parentRoleId = 'parent-1';
    vi.mocked(rolesRepository.findActiveById)
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(parent)
      .mockResolvedValueOnce(updated);
    await service.update('role-1', { reason: 'Motivo de prueba', parentRoleId: 'parent-1' }, actor, ORIGIN);
    expect(rolesRepository.update).toHaveBeenCalledWith('role-1', {
      parentRoleId: 'parent-1',
    });
  });

  it('impide reorganizar la jerarquía si no es super admin', async () => {
    const director: AuthenticatedUser = {
      ...actor,
      id: 'director-1',
      roles: ['INTERNAL_CONTROL_DIRECTOR'],
    };
    const current = customRole();
    current.superiorRoleId = null;
    vi.mocked(rolesRepository.findActiveById).mockResolvedValue(current);
    await expect(
      service.update('role-1', { reason: 'Motivo de prueba', superiorRoleId: 'admin-role' }, director, ORIGIN),
    ).rejects.toMatchObject({ code: ErrorCode.InsufficientPermissions });
    expect(rolesRepository.update).not.toHaveBeenCalled();
  });

  it('padre y superior iguales a los actuales no son reorganizar: renombrar no revalida nada', async () => {
    const current = customRole();
    current.parentRoleId = 'parent-1';
    const renamed = customRole();
    renamed.parentRoleId = 'parent-1';
    renamed.name = 'Coordinación';
    // El linaje aporta un permiso que el actor no tiene: si se revalidara, fallaría con PERMISSION_NOT_HELD.
    vi.mocked(rolesRepository.findPermissionsForRoles).mockResolvedValue([
      { id: 'perm-w', code: 'asset:write_off:global' } as never,
    ]);
    for (const who of [actor, { ...actor, id: 'director-1', roles: ['INTERNAL_CONTROL_DIRECTOR'] }]) {
      vi.mocked(rolesRepository.findActiveById).mockResolvedValueOnce(current).mockResolvedValueOnce(renamed);
      const result = await service.update(
        'role-1',
        { reason: 'Motivo de prueba', name: 'Coordinación', parentRoleId: 'parent-1', superiorRoleId: 'admin-role' },
        who,
        ORIGIN,
      );
      expect(result.name).toBe('Coordinación');
    }
    expect(rolesRepository.findLineage).not.toHaveBeenCalled();
    expect(rolesRepository.update).toHaveBeenCalledWith('role-1', { name: 'Coordinación' });
  });

  it('no reorganiza el rol super admin', async () => {
    vi.mocked(rolesRepository.findActiveById).mockResolvedValue(adminRole());
    await expect(
      service.update('admin-role', { reason: 'Motivo de prueba', superiorRoleId: 'role-1' }, actor, ORIGIN),
    ).rejects.toMatchObject({ code: ErrorCode.RoleSystemImmutable });
    expect(rolesRepository.update).not.toHaveBeenCalled();
  });

  it('bloquea un padre que apunta al mismo rol', async () => {
    const role = customRole();
    vi.mocked(rolesRepository.findActiveById).mockResolvedValue(role);
    await expect(
      service.update('role-1', { reason: 'Motivo de prueba', parentRoleId: 'role-1' }, actor, ORIGIN),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidState });
  });

  it('asigna permisos e invalida cache de asignados', async () => {
    const role = customRole();
    vi.mocked(rolesRepository.findActiveById).mockResolvedValue(role);
    vi.mocked(rolesRepository.findPermissionsByIds).mockResolvedValue([
      {
        id: 'perm-1',
        code: 'asset:read:global',
      } as never,
    ]);
    vi.mocked(rolesRepository.findActiveHolderIdsInheriting).mockResolvedValue([
      'user-9',
    ]);
    await service.assignPermissions(
      'role-1',
      { reason: 'Motivo de prueba', permissionIds: ['perm-1'] },
      actor,
      ORIGIN,
    );
    expect(rolesRepository.assignPermission).toHaveBeenCalled();
    expect(permissionsService.invalidateMany).toHaveBeenCalledWith(['user-9']);
  });

  it('reemplaza el set completo de permisos', async () => {
    const role = customRole();
    vi.mocked(rolesRepository.findActiveById).mockResolvedValue(role);
    vi.mocked(rolesRepository.findPermissionsByIds).mockResolvedValue([
      {
        id: 'perm-1',
        code: 'asset:read:global',
      } as never,
    ]);
    vi.mocked(rolesRepository.findActiveHolderIdsInheriting).mockResolvedValue([
      'user-9',
    ]);
    await service.replacePermissions(
      'role-1',
      { reason: 'Motivo de prueba', permissionIds: ['perm-1'] },
      actor,
      ORIGIN,
    );
    expect(rolesRepository.replacePermissions).toHaveBeenCalledWith(
      'role-1',
      ['perm-1'],
      actor.id,
    );
    expect(permissionsService.invalidateMany).toHaveBeenCalledWith(['user-9']);
  });

  it('crea un rol con permisos iniciales', async () => {
    const created = customRole();
    vi.mocked(rolesRepository.findPermissionsByIds).mockResolvedValue([
      { id: 'perm-1', code: 'asset:read:global' } as never,
    ]);
    vi.mocked(rolesRepository.insert).mockResolvedValue(created);
    await service.create(
      {
        reason: 'Motivo de prueba',
        code: 'ASSET_COORDINATOR',
        name: 'Coordinador',
        permissionIds: ['perm-1'],
      },
      actor,
      ORIGIN,
    );
    expect(rolesRepository.replacePermissions).toHaveBeenCalledWith(
      created.id,
      ['perm-1'],
      actor.id,
    );
  });

  it('rechaza permisos inexistentes al reemplazar', async () => {
    vi.mocked(rolesRepository.findActiveById).mockResolvedValue(customRole());
    vi.mocked(rolesRepository.findPermissionsByIds).mockResolvedValue([]);
    await expect(
      service.replacePermissions(
        'role-1',
        { reason: 'Motivo de prueba', permissionIds: ['perm-missing'] },
        actor,
        ORIGIN,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.ResourceNotFound });
    expect(rolesRepository.replacePermissions).not.toHaveBeenCalled();
  });

  describe('herencia (parentRoleId) — BE-02', () => {
    const director = (): Role => {
      const role = systemRole();
      role.id = 'director-role';
      role.code = 'INTERNAL_CONTROL_DIRECTOR';
      role.hierarchyLevel = 1;
      return role;
    };

    it('fuera de SUPER_ADMIN, no deja heredar de un rol cuyo linaje aporta permisos que el actor no tiene', async () => {
      const directorActor: AuthenticatedUser = { ...actor, id: 'director-1', roles: ['INTERNAL_CONTROL_DIRECTOR'] };
      vi.mocked(rolesRepository.findAllActive).mockResolvedValue([adminRole(), director()]);
      const below = customRole();
      below.hierarchyLevel = 3;
      vi.mocked(rolesRepository.findActiveById).mockResolvedValue(below);
      vi.mocked(rolesRepository.findLineage).mockResolvedValue([below]);
      vi.mocked(rolesRepository.findPermissionsForRoles).mockResolvedValue([
        { id: 'perm-w', code: 'asset:write_off:global' } as never,
      ]);
      await expect(
        service.create(
          { reason: 'Motivo de prueba', code: 'SHADOW', name: 'Sombra', parentRoleId: 'role-1' },
          directorActor,
          ORIGIN,
        ),
      ).rejects.toMatchObject({ code: ErrorCode.PermissionNotHeld });
      expect(rolesRepository.insert).not.toHaveBeenCalled();
    });

    it('SUPER_ADMIN asigna herencia sin tener los permisos del padre, como al otorgar permisos', async () => {
      vi.mocked(rolesRepository.findActiveById).mockResolvedValue(director());
      vi.mocked(rolesRepository.findLineage).mockResolvedValue([director()]);
      vi.mocked(rolesRepository.findPermissionsForRoles).mockResolvedValue([
        { id: 'perm-w', code: 'asset:write_off:global' } as never,
      ]);
      vi.mocked(rolesRepository.insert).mockResolvedValue(customRole());
      await service.create(
        { reason: 'Motivo de prueba', code: 'SHADOW', name: 'Sombra', parentRoleId: 'director-role' },
        actor,
        ORIGIN,
      );
      expect(rolesRepository.insert).toHaveBeenCalledWith(expect.objectContaining({ parentRoleId: 'director-role' }));
    });

    it('no deja heredar de un rol de nivel igual o superior al actor', async () => {
      const directorActor: AuthenticatedUser = {
        ...actor,
        id: 'director-1',
        roles: ['INTERNAL_CONTROL_DIRECTOR'],
      };
      vi.mocked(rolesRepository.findAllActive).mockResolvedValue([
        adminRole(),
        director(),
      ]);
      vi.mocked(rolesRepository.findActiveById).mockResolvedValue(director());
      await expect(
        service.create(
          { reason: 'Motivo de prueba', code: 'SHADOW', name: 'Sombra', parentRoleId: 'director-role' },
          directorActor,
          ORIGIN,
        ),
      ).rejects.toMatchObject({ code: ErrorCode.RolePrivilegeEscalation });
    });

    it('SUPER_ADMIN cambia el padre de un rol existente sin tener los permisos del linaje', async () => {
      vi.mocked(rolesRepository.findActiveById)
        .mockResolvedValueOnce(customRole())
        .mockResolvedValueOnce(director())
        .mockResolvedValueOnce(customRole());
      vi.mocked(rolesRepository.findLineage).mockResolvedValue([director()]);
      vi.mocked(rolesRepository.findPermissionsForRoles).mockResolvedValue([
        { id: 'perm-w', code: 'asset:write_off:global' } as never,
      ]);
      await service.update('role-1', { reason: 'Motivo de prueba', parentRoleId: 'director-role' }, actor, ORIGIN);
      expect(rolesRepository.update).toHaveBeenCalledWith('role-1', { parentRoleId: 'director-role' });
    });

    it('ni SUPER_ADMIN amplía por herencia un rol que tiene', async () => {
      vi.mocked(rolesRepository.findActiveById)
        .mockResolvedValueOnce(customRole())
        .mockResolvedValueOnce(director());
      vi.mocked(rolesRepository.findLineage).mockResolvedValue([director()]);
      vi.mocked(rolesRepository.findPermissionsForRoles).mockResolvedValue([
        { id: 'perm-w', code: 'asset:write_off:global' } as never,
      ]);
      vi.mocked(rolesRepository.findHolderScopesReachingRole).mockResolvedValue([{ scopeType: 'GLOBAL', scopeId: null }] as never);
      await expect(
        service.update('role-1', { reason: 'Motivo de prueba', parentRoleId: 'director-role' }, actor, ORIGIN),
      ).rejects.toMatchObject({ code: ErrorCode.RoleSelfAssignmentForbidden });
      expect(rolesRepository.update).not.toHaveBeenCalled();
    });

    it('un actor no super admin crea el rol un nivel por debajo del suyo', async () => {
      const directorActor: AuthenticatedUser = {
        ...actor,
        id: 'director-1',
        roles: ['INTERNAL_CONTROL_DIRECTOR'],
      };
      vi.mocked(rolesRepository.findAllActive).mockResolvedValue([
        adminRole(),
        director(),
      ]);
      vi.mocked(rolesRepository.insert).mockResolvedValue(customRole());
      await service.create({ reason: 'Motivo de prueba', code: 'ASSISTANT', name: 'Asistente' }, directorActor, ORIGIN);
      expect(rolesRepository.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          superiorRoleId: 'director-role',
          hierarchyLevel: 2,
        }),
      );
    });
  });

  describe('nadie se amplía permisos a sí mismo', () => {
    beforeEach(() => {
      vi.mocked(rolesRepository.findActiveById).mockResolvedValue(customRole());
      vi.mocked(rolesRepository.findPermissionsByIds).mockResolvedValue([
        { id: 'perm-1', code: 'asset:read:global' } as never,
      ]);
      vi.mocked(permissionsService.getEffectivePermissions).mockResolvedValue([
        { permissionCode: 'asset:read:global', userScopeType: 'COST_CENTER', userScopeId: 'cc-1' },
      ]);
    });

    it('no agrega a un rol propio (asignación GLOBAL) un permiso que el actor solo tiene en un centro de costo', async () => {
      vi.mocked(rolesRepository.findHolderScopesReachingRole).mockResolvedValue([
        { scopeType: 'GLOBAL', scopeId: null },
      ]);
      await expect(
        service.assignPermissions('role-1', { reason: 'Motivo de prueba', permissionIds: ['perm-1'] }, actor, ORIGIN),
      ).rejects.toMatchObject({ code: ErrorCode.RoleSelfAssignmentForbidden });
      expect(rolesRepository.assignPermission).not.toHaveBeenCalled();
    });

    it('sí lo agrega si el actor no tiene el rol', async () => {
      await service.assignPermissions('role-1', { reason: 'Motivo de prueba', permissionIds: ['perm-1'] }, actor, ORIGIN);
      expect(rolesRepository.assignPermission).toHaveBeenCalled();
    });
  });

  describe('borrado con herederos — BE-03', () => {
    it('no elimina un rol del que otros roles heredan', async () => {
      vi.mocked(rolesRepository.findActiveById).mockResolvedValue(customRole());
      vi.mocked(rolesRepository.countActiveChildren).mockResolvedValue(1);
      await expect(service.remove('role-1', actor)).rejects.toMatchObject({
        code: ErrorCode.RoleHasChildRoles,
      });
      expect(rolesRepository.softDelete).not.toHaveBeenCalled();
    });

    it('al cambiar permisos invalida también a los titulares de roles herederos', async () => {
      vi.mocked(rolesRepository.findActiveById).mockResolvedValue(customRole());
      vi.mocked(rolesRepository.findActiveHolderIdsInheriting).mockResolvedValue([
        'direct-holder',
        'child-holder',
      ]);
      vi.mocked(rolesRepository.removePermission).mockResolvedValue(true);
      vi.mocked(rolesRepository.findPermissionsByIds).mockResolvedValue([]);
      await service.removePermission('role-1', 'perm-1', { reason: 'Motivo de prueba' }, actor, ORIGIN);
      expect(rolesRepository.findActiveHolderIdsInheriting).toHaveBeenCalledWith(
        'role-1',
      );
      expect(permissionsService.invalidateMany).toHaveBeenCalledWith([
        'direct-holder',
        'child-holder',
      ]);
    });
  });
});
