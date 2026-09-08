import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { Role } from '../../auth/entities/role.entity.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import type { RolesRepository } from '../repositories/roles.repository.interface.js';
import { PermissionsService } from './permissions.service.js';
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
  role.hierarchyLevel = 0;
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
    'invalidateMany'
  >;
  let service: RolesService;

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
    };
    auditLogsRepository = {
      record: vi.fn().mockResolvedValue(undefined),
      findLastLogins: vi.fn(),
    };
    permissionsService = { invalidateMany: vi.fn() };
    service = new RolesService(
      rolesRepository,
      auditLogsRepository,
      permissionsService as PermissionsService,
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
      expect.objectContaining({ isSystem: false, hierarchyLevel: 0 }),
    );
  });

  it('no permite cambiar el nombre de un rol de sistema', async () => {
    vi.mocked(rolesRepository.findActiveById).mockResolvedValue(systemRole());
    await expect(
      service.update('sys-1', { name: 'Otro' }, actor),
    ).rejects.toMatchObject({ code: ErrorCode.RoleSystemImmutable });
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
    vi.mocked(rolesRepository.findActiveById).mockResolvedValue(systemRole());
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
        hierarchyLevel: 3,
      }),
    );
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
