import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { AppUser } from '../entities/app-user.entity.js';
import { Person } from '../entities/person.entity.js';
import { RefreshTokenFamily } from '../entities/refresh-token-family.entity.js';
import { RefreshTokenFamilyStatus } from '../enums/refresh-token-family-status.enum.js';
import { UserStatus } from '../enums/user-status.enum.js';
import type { AuditLogsRepository } from '../repositories/audit-logs.repository.interface.js';
import type { AuthUsersRepository } from '../repositories/auth-users.repository.interface.js';
import type { PasswordResetTokensRepository } from '../repositories/password-reset-tokens.repository.interface.js';
import type { RefreshTokenFamiliesRepository } from '../repositories/refresh-token-families.repository.interface.js';
import { AuthService, requiresMfaEnrollment } from './auth.service.js';
import type { MfaService } from './mfa.service.js';
import type { TokenService } from './token.service.js';
import { FEATURE_CATALOG } from '../../features/feature-catalog.js';
import type { FeatureFlagsService } from '../../features/services/feature-flags.service.js';

const context = { ipAddress: '127.0.0.1', userAgent: 'test' };

const buildUser = (overrides: Partial<AppUser> = {}): AppUser => {
  const person = new Person();
  person.id = 'person-1';
  person.email = 'juliana.perez@unac.edu.co';
  person.firstName = 'Juliana';
  person.lastName = 'Pérez';
  const user = new AppUser();
  user.id = 'user-1';
  user.personId = person.id;
  user.person = person;
  user.username = 'juliana.perez';
  user.passwordHash = 'hash';
  user.status = UserStatus.Active;
  user.mfaEnabled = false;
  user.mfaSecret = null;
  Object.assign(user, overrides);
  return user;
};

const actor: AuthenticatedUser = {
  id: 'user-1',
  personId: 'person-1',
  username: 'juliana.perez',
  roles: ['VIEWER'],
  scopes: [{ type: 'GLOBAL', id: null }],
};

describe('AuthService', () => {
  let authUsersRepository: AuthUsersRepository;
  let refreshTokenFamiliesRepository: RefreshTokenFamiliesRepository;
  let auditLogsRepository: AuditLogsRepository;
  let passwordResetTokensRepository: PasswordResetTokensRepository;
  let hashService: {
    verify: ReturnType<typeof vi.fn>;
    hash: ReturnType<typeof vi.fn>;
    runDummyVerification: ReturnType<typeof vi.fn>;
  };
  let tokenService: {
    signAccessToken: ReturnType<typeof vi.fn>;
    signRefreshToken: ReturnType<typeof vi.fn>;
    signMfaChallengeToken: ReturnType<typeof vi.fn>;
    signMfaSetupToken: ReturnType<typeof vi.fn>;
    verifyRefreshToken: ReturnType<typeof vi.fn>;
    verifyMfaChallengeToken: ReturnType<typeof vi.fn>;
    verifyMfaSetupToken: ReturnType<typeof vi.fn>;
    getAccessTokenLifetimeSeconds: ReturnType<typeof vi.fn>;
    getRefreshTokenLifetimeSeconds: ReturnType<typeof vi.fn>;
    getIssuer: ReturnType<typeof vi.fn>;
  };
  let mfaService: Pick<MfaService, 'verifyTotp' | 'createEnrollment'>;
  let mailService: { sendPasswordReset: ReturnType<typeof vi.fn> };
  let featureFlags: Pick<FeatureFlagsService, 'list'>;
  let service: AuthService;

  beforeEach(() => {
    authUsersRepository = {
      findByUsernameWithPerson: vi.fn(),
      findByEmailWithPerson: vi.fn(),
      findByIdWithPerson: vi.fn(),
      findActiveRoleCodes: vi.fn().mockResolvedValue(['VIEWER']),
      findActiveScopes: vi.fn().mockResolvedValue([]),
      markLoggedIn: vi.fn(),
      updatePassword: vi.fn(),
      activateAfterPasswordReset: vi.fn(),
      findEffectivePermissions: vi.fn().mockResolvedValue([
        {
          code: 'asset:read:org_unit',
          module: 'ASSET',
          resourceType: 'asset',
          action: 'read',
          scopeLevel: 'ORG_UNIT',
        },
      ]),
      saveMfaSecret: vi.fn(),
      enableMfa: vi.fn(),
    };
    refreshTokenFamiliesRepository = {
      findById: vi.fn(),
      insert: vi.fn(),
      rotate: vi.fn().mockResolvedValue(true),
      revoke: vi.fn(),
      revokeAllForUser: vi.fn().mockResolvedValue(1),
    };
    auditLogsRepository = {
      record: vi.fn().mockResolvedValue(undefined),
      findLastLogins: vi.fn().mockResolvedValue([]),
    };
    passwordResetTokensRepository = {
      insert: vi.fn(),
      findValidByHash: vi.fn(),
      markUsed: vi.fn(),
      invalidateUnusedForUser: vi.fn(),
    };
    hashService = {
      verify: vi.fn().mockResolvedValue(true),
      hash: vi.fn().mockResolvedValue('new-hash'),
      runDummyVerification: vi.fn(),
    };
    tokenService = {
      signAccessToken: vi.fn().mockReturnValue('access'),
      signRefreshToken: vi.fn().mockReturnValue('refresh'),
      signMfaChallengeToken: vi.fn().mockReturnValue('challenge'),
      signMfaSetupToken: vi.fn().mockReturnValue('setup'),
      verifyRefreshToken: vi.fn(),
      verifyMfaChallengeToken: vi.fn(),
      verifyMfaSetupToken: vi.fn(),
      getAccessTokenLifetimeSeconds: vi.fn().mockReturnValue(900),
      getRefreshTokenLifetimeSeconds: vi.fn().mockReturnValue(604800),
      getIssuer: vi.fn().mockReturnValue('asset-management-api'),
    };
    mfaService = {
      verifyTotp: vi.fn().mockResolvedValue(true),
      createEnrollment: vi.fn().mockResolvedValue({
        secret: 'SECRET',
        otpauthUrl: 'otpauth://totp/x',
        qrDataUrl: 'data:image/png;base64,iVBORw0KGgo',
      }),
    };
    mailService = { sendPasswordReset: vi.fn() };
    featureFlags = {
      list: vi.fn().mockReturnValue(
        FEATURE_CATALOG.map((feature) => ({
          code: feature.code,
          label: feature.label,
          enabled: true,
          core: feature.core,
          reason: null,
          resourceTypes: feature.resourceTypes,
        })),
      ),
    };
    service = new AuthService(
      authUsersRepository,
      refreshTokenFamiliesRepository,
      auditLogsRepository,
      passwordResetTokensRepository,
      hashService as never,
      tokenService as unknown as TokenService,
      mfaService as MfaService,
      mailService as never,
      featureFlags as FeatureFlagsService,
    );
  });

  describe('login', () => {
    it('emite sesión cuando el username y la contraseña son válidos y no hay MFA', async () => {
      vi.mocked(authUsersRepository.findByUsernameWithPerson).mockResolvedValue(
        buildUser(),
      );
      const outcome = await service.login(
        { username: 'juliana.perez', password: 'C0ntraseña-Segura!' },
        context,
      );
      expect(outcome.refreshToken).toBe('refresh');
      expect('accessToken' in outcome.response).toBe(true);
    });

    it('resuelve la cuenta por correo institucional', async () => {
      vi.mocked(authUsersRepository.findByEmailWithPerson).mockResolvedValue(
        buildUser(),
      );
      await service.login(
        { username: 'juliana.perez@unac.edu.co', password: 'C0ntraseña-Segura!' },
        context,
      );
      expect(authUsersRepository.findByEmailWithPerson).toHaveBeenCalledWith(
        'juliana.perez@unac.edu.co',
      );
    });

    it('no revela si el usuario no existe', async () => {
      vi.mocked(authUsersRepository.findByUsernameWithPerson).mockResolvedValue(
        null,
      );
      await expect(
        service.login({ username: 'nadie', password: 'x' }, context),
      ).rejects.toMatchObject({ code: ErrorCode.InvalidCredentials });
      expect(hashService.runDummyVerification).toHaveBeenCalled();
    });

    it('no revela si la contraseña es incorrecta', async () => {
      vi.mocked(authUsersRepository.findByUsernameWithPerson).mockResolvedValue(
        buildUser(),
      );
      hashService.verify.mockResolvedValue(false);
      await expect(
        service.login({ username: 'juliana.perez', password: 'mala' }, context),
      ).rejects.toMatchObject({ code: ErrorCode.InvalidCredentials });
    });

    it('retorna 403 si la cuenta está suspendida', async () => {
      vi.mocked(authUsersRepository.findByUsernameWithPerson).mockResolvedValue(
        buildUser({ status: UserStatus.Suspended }),
      );
      await expect(
        service.login({ username: 'juliana.perez', password: 'x' }, context),
      ).rejects.toMatchObject({ code: ErrorCode.UserSuspended });
    });

    it('retorna challenge cuando MFA ya está activo', async () => {
      vi.mocked(authUsersRepository.findByUsernameWithPerson).mockResolvedValue(
        buildUser({ mfaEnabled: true, mfaSecret: 's' }),
      );
      const outcome = await service.login(
        { username: 'juliana.perez', password: 'C0ntraseña-Segura!' },
        context,
      );
      expect(outcome.refreshToken).toBeNull();
      expect(outcome.response).toMatchObject({ requiresMfa: true });
    });

    it('fuerza setup MFA para administradores sin enrolar', async () => {
      vi.mocked(authUsersRepository.findByUsernameWithPerson).mockResolvedValue(
        buildUser(),
      );
      vi.mocked(authUsersRepository.findActiveRoleCodes).mockResolvedValue([
        'SUPER_ADMIN',
      ]);
      const outcome = await service.login(
        { username: 'admin', password: 'C0ntraseña-Segura!' },
        context,
      );
      expect(outcome.response).toMatchObject({ requiresMfaSetup: true });
    });
  });

  describe('beginMfaSetup', () => {
    it('devuelve secreto, otpauthUrl y qrDataUrl sin persistir la imagen', async () => {
      tokenService.verifyMfaSetupToken.mockReturnValue({
        sub: 'user-1',
        username: 'juliana.perez',
        type: 'mfa_setup',
      });
      vi.mocked(authUsersRepository.findByIdWithPerson).mockResolvedValue(
        buildUser(),
      );
      const response = await service.beginMfaSetup('Bearer setup');
      expect(response).toEqual({
        secret: 'SECRET',
        otpauthUrl: 'otpauth://totp/x',
        qrDataUrl: 'data:image/png;base64,iVBORw0KGgo',
      });
      expect(authUsersRepository.saveMfaSecret).toHaveBeenCalledWith(
        'user-1',
        'SECRET',
      );
    });
  });

  describe('verifyMfa', () => {
    it('emite sesión cuando el código TOTP es válido', async () => {
      tokenService.verifyMfaChallengeToken.mockReturnValue({
        sub: 'user-1',
        username: 'juliana.perez',
        type: 'mfa_challenge',
      });
      vi.mocked(authUsersRepository.findByIdWithPerson).mockResolvedValue(
        buildUser({ mfaEnabled: true, mfaSecret: 's' }),
      );
      const outcome = await service.verifyMfa(
        { code: '123456' },
        'Bearer challenge',
        context,
      );
      expect(outcome.refreshToken).toBe('refresh');
    });

    it('rechaza un código TOTP inválido', async () => {
      tokenService.verifyMfaChallengeToken.mockReturnValue({
        sub: 'user-1',
        username: 'juliana.perez',
        type: 'mfa_challenge',
      });
      vi.mocked(authUsersRepository.findByIdWithPerson).mockResolvedValue(
        buildUser({ mfaEnabled: true, mfaSecret: 's' }),
      );
      vi.mocked(mfaService.verifyTotp).mockResolvedValue(false);
      await expect(
        service.verifyMfa({ code: '000000' }, 'Bearer challenge', context),
      ).rejects.toMatchObject({ code: ErrorCode.MfaCodeInvalid });
    });
  });

  describe('refresh', () => {
    it('rota la familia cuando el jti es el vigente', async () => {
      tokenService.verifyRefreshToken.mockReturnValue({
        sub: 'user-1',
        familyId: 'fam-1',
        jti: 'jti-1',
        type: 'refresh',
      });
      const family = new RefreshTokenFamily();
      family.id = 'fam-1';
      family.userId = 'user-1';
      family.currentJti = 'jti-1';
      family.status = RefreshTokenFamilyStatus.Active;
      family.expiresAt = new Date(Date.now() + 60_000);
      vi.mocked(refreshTokenFamiliesRepository.findById).mockResolvedValue(
        family,
      );
      vi.mocked(authUsersRepository.findByIdWithPerson).mockResolvedValue(
        buildUser(),
      );
      const outcome = await service.refresh('refresh-token', context);
      expect(outcome.refreshToken).toBe('refresh');
      expect(refreshTokenFamiliesRepository.rotate).toHaveBeenCalled();
    });

    it('detecta reuso de refresh e invalida la familia', async () => {
      tokenService.verifyRefreshToken.mockReturnValue({
        sub: 'user-1',
        familyId: 'fam-1',
        jti: 'jti-old',
        type: 'refresh',
      });
      const family = new RefreshTokenFamily();
      family.id = 'fam-1';
      family.userId = 'user-1';
      family.currentJti = 'jti-1';
      family.status = RefreshTokenFamilyStatus.Active;
      family.expiresAt = new Date(Date.now() + 60_000);
      vi.mocked(refreshTokenFamiliesRepository.findById).mockResolvedValue(
        family,
      );
      await expect(service.refresh('stale', context)).rejects.toMatchObject({
        code: ErrorCode.TokenExpired,
      });
      expect(refreshTokenFamiliesRepository.revoke).toHaveBeenCalled();
    });
  });

  describe('me', () => {
    it('incluye permisos efectivos', async () => {
      vi.mocked(authUsersRepository.findByIdWithPerson).mockResolvedValue(
        buildUser(),
      );
      const me = await service.me(actor);
      expect(me.permissions).toEqual(['asset:read:org_unit']);
      expect(me.capabilities).toEqual([
        {
          resource: 'asset',
          module: 'ASSET',
          actions: ['read'],
          scopes: ['ORG_UNIT'],
        },
      ]);
      expect(me.navigation).toEqual([
        {
          module: 'ASSET',
          moduleLabel: 'Activos',
          resource: 'asset',
          path: '/assets',
          label: 'Activos',
        },
      ]);
      expect(me.features.find((item) => item.code === 'assets')?.enabled).toBe(
        true,
      );
    });
  });

  describe('logout', () => {
    it('revoca todas las familias del usuario', async () => {
      await service.logout(actor, context);
      expect(refreshTokenFamiliesRepository.revokeAllForUser).toHaveBeenCalled();
    });
  });
});

describe('requiresMfaEnrollment', () => {
  it('es verdadero para administradores', () => {
    expect(requiresMfaEnrollment(['SUPER_ADMIN'])).toBe(true);
    expect(requiresMfaEnrollment(['INTERNAL_CONTROL_DIRECTOR'])).toBe(true);
  });

  it('es falso para roles operativos', () => {
    expect(requiresMfaEnrollment(['VIEWER', 'CUSTODIAN'])).toBe(false);
  });
});
