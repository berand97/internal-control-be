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
      findActiveAssigneeIds: vi.fn().mockResolvedValue([]),
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
      { code: 'ASSET_COORDINATOR', name: 'Coordinador' },
      actor,
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
    const result = await service.update('dir-1', { name: 'Dirección' }, actor);
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
    const result = await service.update('admin-role', { name: 'Super Admin' }, actor);
    expect(rolesRepository.update).toHaveBeenCalledWith(
      'admin-role',
      expect.objectContaining({ name: 'Super Admin' }),
    );
    expect(result.name).toBe('Super Admin');
  });

  it('no permite editar un rol igual o superior', async () => {
    vi.mocked(rolesRepository.findActiveById).mockResolvedValue(adminRole());
    await expect(
      service.replacePermissions('admin-role', { permissionIds: [] }, actor),
    ).rejects.toMatchObject({ code: ErrorCode.RolePrivilegeEscalation });
    expect(rolesRepository.replacePermissions).not.toHaveBeenCalled();
  });

  it('no permite conceder un permiso que el actor no tiene', async () => {
    vi.mocked(rolesRepository.findActiveById).mockResolvedValue(customRole());
    vi.mocked(rolesRepository.findPermissionsByIds).mockResolvedValue([
      { id: 'perm-admin', code: 'role:manage:global' } as never,
    ]);
    await expect(
      service.replacePermissions(
        'role-1',
        { permissionIds: ['perm-admin'] },
        actor,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.PermissionNotHeld });
    expect(rolesRepository.replacePermissions).not.toHaveBeenCalled();
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
        code: 'ASSET_COORDINATOR',
        name: 'Coordinador',
        parentRoleId: 'parent-1',
      },
      actor,
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
    const superior = adminRole();
    const moved = customRole();
    moved.superiorRoleId = 'admin-role';
    moved.hierarchyLevel = 1;
    vi.mocked(rolesRepository.findActiveById)
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(superior)
      .mockResolvedValueOnce(moved);
    await service.update('role-1', { superiorRoleId: 'admin-role' }, actor);
    expect(rolesRepository.update).toHaveBeenCalledWith('role-1', {
      superiorRoleId: 'admin-role',
      hierarchyLevel: 1,
    });
  });

  it('permite al super admin cambiar el padre sin recalcular el nivel', async () => {
    const current = customRole();
    const parent = adminRole();
    parent.id = 'parent-1';
    const updated = customRole();
    updated.parentRoleId = 'parent-1';
    vi.mocked(rolesRepository.findActiveById)
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(parent)
      .mockResolvedValueOnce(updated);
    await service.update('role-1', { parentRoleId: 'parent-1' }, actor);
    expect(rolesRepository.update).toHaveBeenCalledWith('role-1', {
      parentRoleId: 'parent-1',
    });
  });

  it('impide reorganizar la jerarquía si no es super admin', async () => {
    const director: AuthenticatedUser = {
      ...actor,
      roles: ['INTERNAL_CONTROL_DIRECTOR'],
    };
    vi.mocked(rolesRepository.findActiveById).mockResolvedValue(customRole());
    await expect(
      service.update('role-1', { superiorRoleId: 'admin-role' }, director),
    ).rejects.toMatchObject({ code: ErrorCode.InsufficientPermissions });
    expect(rolesRepository.update).not.toHaveBeenCalled();
  });

  it('no reorganiza el rol super admin', async () => {
    vi.mocked(rolesRepository.findActiveById).mockResolvedValue(adminRole());
    await expect(
      service.update('admin-role', { superiorRoleId: 'role-1' }, actor),
    ).rejects.toMatchObject({ code: ErrorCode.RoleSystemImmutable });
    expect(rolesRepository.update).not.toHaveBeenCalled();
  });

  it('bloquea un padre que apunta al mismo rol', async () => {
    const role = customRole();
    vi.mocked(rolesRepository.findActiveById).mockResolvedValue(role);
    await expect(
      service.update('role-1', { parentRoleId: 'role-1' }, actor),
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
    vi.mocked(rolesRepository.findActiveAssigneeIds).mockResolvedValue([
      'user-9',
    ]);
    await service.assignPermissions(
      'role-1',
      { permissionIds: ['perm-1'] },
      actor,
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
    vi.mocked(rolesRepository.findActiveAssigneeIds).mockResolvedValue([
      'user-9',
    ]);
    await service.replacePermissions(
      'role-1',
      { permissionIds: ['perm-1'] },
      actor,
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
        code: 'ASSET_COORDINATOR',
        name: 'Coordinador',
        permissionIds: ['perm-1'],
      },
      actor,
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
        { permissionIds: ['perm-missing'] },
        actor,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.ResourceNotFound });
    expect(rolesRepository.replacePermissions).not.toHaveBeenCalled();
  });
});
