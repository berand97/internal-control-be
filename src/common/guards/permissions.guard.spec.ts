import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../constants/error-code.enum.js';
import { REQUIRE_PERMISSION_KEY } from '../decorators/require-permission.decorator.js';
import type { AuthenticatedUser } from '../types/authenticated-user.type.js';
import { PermissionsGuard } from './permissions.guard.js';

const user: AuthenticatedUser = {
  id: 'user-1',
  personId: 'person-1',
  username: 'ana.ruiz',
  roles: ['DEPARTMENT_HEAD'],
  scopes: [{ type: 'ORG_UNIT', id: 'ou-1' }],
};

const createContext = (request: {
  readonly user?: AuthenticatedUser;
  readonly params?: Record<string, string>;
  readonly body?: Record<string, unknown>;
}): ExecutionContext =>
  ({
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  }) as ExecutionContext;

describe('PermissionsGuard', () => {
  let reflector: Reflector;
  let permissionsService: { userHasPermission: ReturnType<typeof vi.fn> };
  let guard: PermissionsGuard;

  beforeEach(() => {
    reflector = {
      getAllAndOverride: vi.fn(),
    } as unknown as Reflector;
    permissionsService = { userHasPermission: vi.fn().mockResolvedValue(true) };
    guard = new PermissionsGuard(reflector, permissionsService as never);
  });

  it('permite sin decorador', async () => {
    vi.mocked(reflector.getAllAndOverride).mockReturnValue(undefined);
    await expect(
      guard.canActivate(createContext({ user })),
    ).resolves.toBe(true);
  });

  it('pasa permiso global sin scope', async () => {
    vi.mocked(reflector.getAllAndOverride).mockReturnValue({
      code: 'role:read:global',
    });
    await guard.canActivate(createContext({ user }));
    expect(permissionsService.userHasPermission).toHaveBeenCalledWith(
      'user-1',
      'role:read:global',
      undefined,
    );
  });

  it('deriva scope ORG_UNIT del request', async () => {
    vi.mocked(reflector.getAllAndOverride).mockReturnValue({
      code: 'asset:update:org_unit',
    });
    await guard.canActivate(
      createContext({
        user,
        params: { orgUnitId: 'ou-ingenieria' },
        body: {},
      }),
    );
    expect(permissionsService.userHasPermission).toHaveBeenCalledWith(
      'user-1',
      'asset:update:org_unit',
      { type: 'ORG_UNIT', id: 'ou-ingenieria' },
    );
  });

  it('deriva scope COST_CENTER del request', async () => {
    vi.mocked(reflector.getAllAndOverride).mockReturnValue({
      code: 'asset:read:cost_center',
    });
    await guard.canActivate(
      createContext({
        user,
        params: { costCenterId: 'cc-1' },
        body: {},
      }),
    );
    expect(permissionsService.userHasPermission).toHaveBeenCalledWith(
      'user-1',
      'asset:read:cost_center',
      { type: 'COST_CENTER', id: 'cc-1' },
    );
  });

  it('rechaza OWN cuando el recurso es de otro usuario', async () => {
    vi.mocked(reflector.getAllAndOverride).mockReturnValue({
      code: 'loan:request:own',
    });
    await expect(
      guard.canActivate(
        createContext({
          user,
          params: {},
          body: { requestedBy: 'otro-user' },
        }),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.OutOfScope });
  });

  it('rechaza 403 cuando el servicio niega el permiso', async () => {
    vi.mocked(reflector.getAllAndOverride).mockReturnValue({
      code: 'user:manage:global',
    });
    permissionsService.userHasPermission.mockResolvedValue(false);
    await expect(
      guard.canActivate(createContext({ user })),
    ).rejects.toMatchObject({ code: ErrorCode.InsufficientPermissions });
  });
});

describe('REQUIRE_PERMISSION_KEY', () => {
  it('está definido para el reflector', () => {
    expect(REQUIRE_PERMISSION_KEY).toBe('requirePermission');
  });
});
