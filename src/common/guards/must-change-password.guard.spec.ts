import { ExecutionContext } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../constants/error-code.enum.js';
import { ALLOW_WHILE_MUST_CHANGE_PASSWORD_KEY } from '../decorators/allow-while-must-change-password.decorator.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import type { AuthenticatedUser } from '../types/authenticated-user.type.js';
import { MustChangePasswordGuard } from './must-change-password.guard.js';

const user: AuthenticatedUser = {
  id: 'user-1',
  personId: 'person-1',
  username: 'ana.ruiz@unac.edu.co',
  roles: [],
  scopes: [],
  mustChangePassword: true,
};

const createContext = (requestUser?: AuthenticatedUser): ExecutionContext =>
  ({
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({ user: requestUser }),
    }),
  }) as ExecutionContext;

describe('MustChangePasswordGuard', () => {
  const reflector = { getAllAndOverride: vi.fn() };
  let guard: MustChangePasswordGuard;

  beforeEach(() => {
    reflector.getAllAndOverride.mockReset();
    guard = new MustChangePasswordGuard(reflector as never);
  });

  it('deja pasar rutas públicas', () => {
    reflector.getAllAndOverride.mockImplementation((key: string) =>
      key === IS_PUBLIC_KEY ? true : undefined,
    );
    expect(guard.canActivate(createContext(user))).toBe(true);
  });

  it('deja pasar si no hay cambio de contraseña pendiente', () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    expect(
      guard.canActivate(
        createContext({ ...user, mustChangePassword: false }),
      ),
    ).toBe(true);
  });

  it('permite me, logout y change-password', () => {
    reflector.getAllAndOverride.mockImplementation((key: string) =>
      key === ALLOW_WHILE_MUST_CHANGE_PASSWORD_KEY ? true : undefined,
    );
    expect(guard.canActivate(createContext(user))).toBe(true);
  });

  it('bloquea el resto de rutas autenticadas', () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    try {
      guard.canActivate(createContext(user));
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: ErrorCode.PasswordChangeRequired });
    }
  });
});
