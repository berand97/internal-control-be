import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionsRepository } from '../repositories/permissions.repository.interface.js';
import type { EffectivePermission } from '../types/effective-permission.type.js';
import { PermissionsCache } from './permissions-cache.service.js';
import { PermissionsService } from './permissions.service.js';

const permissions: ReadonlyArray<EffectivePermission> = [
  {
    permissionCode: 'role:read:global',
    userScopeType: 'GLOBAL',
    userScopeId: null,
  },
  {
    permissionCode: 'asset:update:org_unit',
    userScopeType: 'ORG_UNIT',
    userScopeId: 'ou-ingenieria',
  },
];

describe('PermissionsService', () => {
  let repository: PermissionsRepository;
  let cache: PermissionsCache;
  let service: PermissionsService;

  beforeEach(() => {
    repository = {
      findEffectivePermissions: vi.fn().mockResolvedValue(permissions),
    };
    cache = new PermissionsCache();
    service = new PermissionsService(repository, cache);
  });

  it('permite permiso global sin scope', async () => {
    await expect(
      service.userHasPermission('user-1', 'role:read:global'),
    ).resolves.toBe(true);
  });

  it('permite permiso :global aunque la adscripción sea de unidad', async () => {
    vi.mocked(repository.findEffectivePermissions).mockResolvedValue([
      {
        permissionCode: 'inventory:read:global',
        userScopeType: 'ORG_UNIT',
        userScopeId: 'ou-ingenieria',
      },
    ]);
    await expect(
      service.userHasPermission('user-1', 'inventory:read:global'),
    ).resolves.toBe(true);
  });

  it('permite permiso :global aunque la adscripción sea de centro de costo', async () => {
    vi.mocked(repository.findEffectivePermissions).mockResolvedValue([
      {
        permissionCode: 'inventory:read:global',
        userScopeType: 'COST_CENTER',
        userScopeId: 'cc-1',
      },
    ]);
    await expect(
      service.userHasPermission('user-1', 'inventory:read:global'),
    ).resolves.toBe(true);
  });

  it('permite permiso de unidad con scope coincidente', async () => {
    await expect(
      service.userHasPermission('user-1', 'asset:update:org_unit', {
        type: 'ORG_UNIT',
        id: 'ou-ingenieria',
      }),
    ).resolves.toBe(true);
  });

  it('rechaza permiso de unidad con scope distinto', async () => {
    await expect(
      service.userHasPermission('user-1', 'asset:update:org_unit', {
        type: 'ORG_UNIT',
        id: 'ou-salud',
      }),
    ).resolves.toBe(false);
  });

  it('rechaza cuando no hay permiso', async () => {
    await expect(
      service.userHasPermission('user-1', 'user:manage:global'),
    ).resolves.toBe(false);
  });

  it('usa cache en la segunda consulta', async () => {
    await service.getEffectivePermissions('user-1');
    await service.getEffectivePermissions('user-1');
    expect(repository.findEffectivePermissions).toHaveBeenCalledTimes(1);
  });

  it('invalida cache y vuelve a consultar', async () => {
    await service.getEffectivePermissions('user-1');
    service.invalidate('user-1');
    await service.getEffectivePermissions('user-1');
    expect(repository.findEffectivePermissions).toHaveBeenCalledTimes(2);
  });
  it('costCenterScope resuelve centros desde los permisos efectivos del usuario', async () => {
    vi.mocked(repository.findEffectivePermissions).mockResolvedValue([
      { permissionCode: 'asset:read:org_unit', userScopeType: 'COST_CENTER', userScopeId: 'cc-1' },
      { permissionCode: 'asset:read:org_unit', userScopeType: 'ORG_UNIT', userScopeId: 'ou-1' },
    ]);
    await expect(
      service.costCenterScope('user-1', 'asset:read:global', 'asset:read:org_unit'),
    ).resolves.toEqual({ kind: 'COST_CENTERS', costCenterIds: ['cc-1'] });
    await expect(
      service.costCenterScope('user-1', 'loan:approve:global', 'loan:approve:org_unit'),
    ).resolves.toEqual({ kind: 'DENIED' });
    expect(repository.findEffectivePermissions).toHaveBeenCalledTimes(1);
  });
});
