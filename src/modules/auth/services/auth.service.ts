import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { HashService } from '../../../shared/crypto/hash.service.js';
import { MailService } from '../../../shared/mail/mail.service.js';
import { AppUser } from '../entities/app-user.entity.js';
import { RefreshTokenFamily } from '../entities/refresh-token-family.entity.js';
import { ChangePasswordDto } from '../dto/change-password.dto.js';
import { ForgotPasswordDto } from '../dto/forgot-password.dto.js';
import { LoginDto } from '../dto/login.dto.js';
import { ResetPasswordDto } from '../dto/reset-password.dto.js';
import { VerifyMfaDto } from '../dto/verify-mfa.dto.js';
import { VerifyRecoveryCodeDto } from '../dto/verify-recovery-code.dto.js';
import { LoginResponseDto } from '../dto/responses/login-response.dto.js';
import { MeResponseDto } from '../dto/responses/me-response.dto.js';
import { MfaChallengeResponseDto } from '../dto/responses/mfa-challenge-response.dto.js';
import { MfaEnrollmentResponseDto } from '../dto/responses/mfa-enrollment.response.dto.js';
import { MfaSetupConfirmedResponseDto } from '../dto/responses/mfa-setup-confirmed.response.dto.js';
import { MfaSetupRequiredResponseDto } from '../dto/responses/mfa-setup-required.response.dto.js';
import { RecoveryLoginResponseDto } from '../dto/responses/recovery-login-response.dto.js';
import { RefreshResponseDto } from '../dto/responses/refresh-response.dto.js';
import { AuditAction } from '../enums/audit-action.enum.js';
import { RefreshTokenFamilyStatus } from '../enums/refresh-token-family-status.enum.js';
import { UserStatus } from '../enums/user-status.enum.js';
import type { AuditLogsRepository } from '../repositories/audit-logs.repository.interface.js';
import type { AuthUsersRepository } from '../repositories/auth-users.repository.interface.js';
import type { PasswordResetTokensRepository } from '../repositories/password-reset-tokens.repository.interface.js';
import type { RefreshTokenFamiliesRepository } from '../repositories/refresh-token-families.repository.interface.js';
import type { RefreshTokenPayload } from '../types/token-payloads.type.js';
import { MfaAccountService, type MfaProofMethod } from './mfa-account.service.js';
import { requiresMfaEnrollment } from './mfa-policy.js';
import { MfaService } from './mfa.service.js';
import { TokenService } from './token.service.js';
import { FeatureFlagsService } from '../../features/services/feature-flags.service.js';
import { NavigationService } from '../../navigation/services/navigation.service.js';

export interface AuthRequestContext {
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export interface AuthenticatedLoginOutcome {
  readonly response: LoginResponseDto;
  readonly refreshToken: string;
}

export interface MfaChallengeOutcome {
  readonly response: MfaChallengeResponseDto;
  readonly refreshToken: null;
}

export interface MfaSetupOutcome {
  readonly response: MfaSetupRequiredResponseDto;
  readonly refreshToken: null;
}

export type LoginOutcome =
  | AuthenticatedLoginOutcome
  | MfaChallengeOutcome
  | MfaSetupOutcome;

export interface RefreshOutcome {
  readonly response: RefreshResponseDto;
  readonly refreshToken: string;
}

const NIL_ENTITY_ID = '00000000-0000-0000-0000-000000000000';
const USER_ENTITY_TYPE = 'USER';
const LAST_LOGINS_LIMIT = 5;
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;

@Injectable()
export class AuthService {
  constructor(
    @Inject('AuthUsersRepository')
    private readonly authUsersRepository: AuthUsersRepository,
    @Inject('RefreshTokenFamiliesRepository')
    private readonly refreshTokenFamiliesRepository: RefreshTokenFamiliesRepository,
    @Inject('AuditLogsRepository')
    private readonly auditLogsRepository: AuditLogsRepository,
    @Inject('PasswordResetTokensRepository')
    private readonly passwordResetTokensRepository: PasswordResetTokensRepository,
    private readonly hashService: HashService,
    private readonly tokenService: TokenService,
    private readonly mfaService: MfaService,
    private readonly mailService: MailService,
    private readonly featureFlags: FeatureFlagsService,
    private readonly navigationService: NavigationService,
    private readonly mfaAccount: MfaAccountService,
  ) {}

  async login(
    dto: LoginDto,
    context: AuthRequestContext,
  ): Promise<LoginOutcome> {
    const user = await this.findUserForLogin(dto.username);

    if (!user) {
      await this.hashService.runDummyVerification(dto.password);
      await this.recordAudit(
        AuditAction.LoginFailed,
        NIL_ENTITY_ID,
        null,
        context,
        {
          username: dto.username,
          reason: 'USER_NOT_FOUND',
        },
      );
      throw new ApiException(ErrorCode.InvalidCredentials);
    }

    this.assertAccountUsable(user);

    const passwordMatches = await this.hashService.verify(
      user.passwordHash,
      dto.password,
    );
    if (!passwordMatches) {
      await this.recordAudit(
        AuditAction.LoginFailed,
        user.id,
        user.id,
        context,
        {
          username: user.username,
          reason: 'BAD_PASSWORD',
        },
      );
      throw new ApiException(ErrorCode.InvalidCredentials);
    }

    if (user.mfaEnabled) {
      const mfaChallengeToken = this.tokenService.signMfaChallengeToken(
        user.id,
        user.username,
      );
      return {
        response: MfaChallengeResponseDto.from(mfaChallengeToken),
        refreshToken: null,
      };
    }

    const roleCodes = await this.authUsersRepository.findActiveRoleCodes(
      user.id,
    );
    if (
      !user.mustChangePassword &&
      (requiresMfaEnrollment(roleCodes) || user.mfaEnrollmentRequired)
    ) {
      return {
        response: MfaSetupRequiredResponseDto.from(
          this.tokenService.signMfaSetupToken(user.id, user.username),
        ),
        refreshToken: null,
      };
    }

    return this.issueSession(user, context);
  }

  async verifyMfa(
    dto: VerifyMfaDto,
    authorizationHeader: string | undefined,
    context: AuthRequestContext,
  ): Promise<AuthenticatedLoginOutcome> {
    const challenge =
      this.tokenService.verifyMfaChallengeToken(authorizationHeader);
    const user = await this.authUsersRepository.findByIdWithPerson(
      challenge.sub,
    );

    if (!user || !user.mfaEnabled || !user.mfaSecret) {
      throw new ApiException(ErrorCode.MfaRequired);
    }

    this.assertAccountUsable(user);

    const codeValid = await this.mfaService.verifyTotp(
      dto.code,
      user.mfaSecret,
    );
    if (!codeValid) {
      await this.recordAudit(
        AuditAction.LoginFailed,
        user.id,
        user.id,
        context,
        {
          username: user.username,
          reason: 'MFA_CODE_INVALID',
        },
      );
      throw new ApiException(ErrorCode.MfaCodeInvalid);
    }

    return this.issueSession(user, context, 'TOTP');
  }

  /**
   * Alternativa a POST /auth/mfa/verify cuando no se tiene el dispositivo: consume un código de recuperación del
   * usuario del desafío. El código queda usado aunque la sesión se cierre enseguida.
   */
  async verifyRecoveryCode(
    dto: VerifyRecoveryCodeDto,
    authorizationHeader: string | undefined,
    context: AuthRequestContext,
  ): Promise<{
    readonly response: RecoveryLoginResponseDto;
    readonly refreshToken: string;
  }> {
    const challenge =
      this.tokenService.verifyMfaChallengeToken(authorizationHeader);
    const user = await this.authUsersRepository.findByIdWithPerson(
      challenge.sub,
    );
    if (!user || !user.mfaEnabled) {
      throw new ApiException(ErrorCode.MfaRequired);
    }
    this.assertAccountUsable(user);

    const remaining = await this.mfaAccount.consumeForLogin(
      user,
      dto.recoveryCode,
      context,
    );
    if (remaining === null) {
      await this.recordAudit(
        AuditAction.LoginFailed,
        user.id,
        user.id,
        context,
        {
          username: user.username,
          reason: 'MFA_RECOVERY_CODE_INVALID',
        },
      );
      throw new ApiException(ErrorCode.MfaCodeInvalid);
    }

    const outcome = await this.issueSession(user, context, 'RECOVERY_CODE');
    return {
      response: RecoveryLoginResponseDto.withRemaining(
        outcome.response,
        remaining,
      ),
      refreshToken: outcome.refreshToken,
    };
  }

  async refresh(
    refreshToken: string | undefined,
    context: AuthRequestContext,
  ): Promise<RefreshOutcome> {
    if (refreshToken === undefined) {
      throw new ApiException(ErrorCode.TokenExpired);
    }

    const payload = this.tokenService.verifyRefreshToken(refreshToken);
    const family = await this.refreshTokenFamiliesRepository.findById(
      payload.familyId,
    );
    const now = new Date();

    if (!family) {
      throw new ApiException(ErrorCode.TokenExpired);
    }

    if (
      family.status === RefreshTokenFamilyStatus.Revoked ||
      family.expiresAt <= now
    ) {
      await this.handleReuseDetected(
        family,
        payload,
        context,
        'REVOKED_OR_EXPIRED_FAMILY',
      );
      throw new ApiException(ErrorCode.TokenExpired);
    }

    if (family.currentJti !== payload.jti) {
      await this.handleReuseDetected(family, payload, context, 'STALE_JTI');
      throw new ApiException(ErrorCode.TokenExpired);
    }

    const user = await this.authUsersRepository.findByIdWithPerson(payload.sub);
    if (!user) {
      await this.refreshTokenFamiliesRepository.revoke(family.id, now);
      throw new ApiException(ErrorCode.TokenExpired);
    }
    this.assertAccountUsable(user);

    const newJti = randomUUID();
    const expiresAt = this.refreshExpiryFrom(now);
    const rotated = await this.refreshTokenFamiliesRepository.rotate({
      id: family.id,
      expectedJti: payload.jti,
      newJti,
      expiresAt,
    });

    if (!rotated) {
      await this.handleReuseDetected(family, payload, context, 'ROTATION_RACE');
      throw new ApiException(ErrorCode.TokenExpired);
    }

    const [roles, scopes] = await Promise.all([
      this.authUsersRepository.findActiveRoleCodes(user.id),
      this.authUsersRepository.findActiveScopes(user.id),
    ]);
    const authenticatedUser = this.toAuthenticatedUser(user, roles, scopes);

    const accessToken = this.tokenService.signAccessToken({
      ...authenticatedUser,
      sessionId: family.id,
    });
    const rotatedRefreshToken = this.tokenService.signRefreshToken(
      user.id,
      family.id,
      newJti,
    );

    await this.recordAudit(
      AuditAction.TokenRefreshed,
      user.id,
      user.id,
      context,
      {
        familyId: family.id,
      },
    );

    return {
      response: RefreshResponseDto.from(
        accessToken,
        this.tokenService.getAccessTokenLifetimeSeconds(),
      ),
      refreshToken: rotatedRefreshToken,
    };
  }

  async logout(
    user: AuthenticatedUser,
    context: AuthRequestContext,
  ): Promise<void> {
    await this.refreshTokenFamiliesRepository.revokeAllForUser(
      user.id,
      new Date(),
    );
    await this.recordAudit(AuditAction.Logout, user.id, user.id, context, null);
  }

  async me(user: AuthenticatedUser): Promise<MeResponseDto> {
    const dbUser = await this.authUsersRepository.findByIdWithPerson(user.id);
    if (!dbUser) {
      throw new ApiException(ErrorCode.Unauthorized);
    }

    const [roles, scopes, lastLogins, granted, catalog] = await Promise.all([
      this.authUsersRepository.findActiveRoleCodes(user.id),
      this.authUsersRepository.findActiveScopes(user.id),
      this.auditLogsRepository.findLastLogins(user.id, LAST_LOGINS_LIMIT),
      this.authUsersRepository.findEffectivePermissions(user.id),
      this.navigationService.listActiveDefinitions(),
    ]);

    const mfa = await this.mfaAccount.status(user, dbUser, roles);

    return MeResponseDto.from(
      dbUser,
      roles,
      scopes,
      lastLogins,
      granted,
      this.featureFlags.list(),
      catalog,
      mfa,
    );
  }

  async beginMfaSetup(
    authorizationHeader: string | undefined,
  ): Promise<MfaEnrollmentResponseDto> {
    const setup = this.tokenService.verifyMfaSetupToken(authorizationHeader);
    const user = await this.authUsersRepository.findByIdWithPerson(setup.sub);
    if (!user || user.mfaEnabled) {
      throw new ApiException(ErrorCode.MfaRequired);
    }
    this.assertAccountUsable(user);
    const enrollment = await this.mfaService.createEnrollment(
      user.person?.email ?? user.username,
      this.tokenService.getIssuer(),
    );
    await this.authUsersRepository.saveMfaSecret(user.id, enrollment.secret);
    return MfaEnrollmentResponseDto.from(
      enrollment.secret,
      enrollment.otpauthUrl,
      enrollment.qrDataUrl,
    );
  }

  async confirmMfaSetup(
    dto: VerifyMfaDto,
    authorizationHeader: string | undefined,
    context: AuthRequestContext,
  ): Promise<{
    readonly response: MfaSetupConfirmedResponseDto;
    readonly refreshToken: string;
  }> {
    const setup = this.tokenService.verifyMfaSetupToken(authorizationHeader);
    const user = await this.authUsersRepository.findByIdWithPerson(setup.sub);
    if (!user || !user.mfaSecret || user.mfaEnabled) {
      throw new ApiException(ErrorCode.MfaRequired);
    }
    this.assertAccountUsable(user);
    const codeValid = await this.mfaService.verifyTotp(dto.code, user.mfaSecret);
    if (!codeValid) {
      throw new ApiException(ErrorCode.MfaCodeInvalid);
    }
    const recoveryCodes = await this.mfaAccount.completeSetupEnrollment(
      user,
      user.mfaSecret,
      context,
    );
    user.mfaEnabled = true;
    user.mfaEnrollmentRequired = false;
    const outcome = await this.issueSession(user, context, 'TOTP');
    return {
      response: MfaSetupConfirmedResponseDto.withCodes(
        outcome.response,
        recoveryCodes,
      ),
      refreshToken: outcome.refreshToken,
    };
  }

  async forgotPassword(
    dto: ForgotPasswordDto,
    context: AuthRequestContext,
  ): Promise<null> {
    const user = await this.authUsersRepository.findByEmailWithPerson(
      dto.email,
    );
    if (!user) {
      await this.hashService.runDummyVerification(dto.email);
      return null;
    }

    const { token, tokenHash } = this.createPasswordResetToken();
    const now = new Date();
    await this.passwordResetTokensRepository.invalidateUnusedForUser(
      user.id,
      now,
    );
    await this.passwordResetTokensRepository.insert({
      userId: user.id,
      tokenHash,
      expiresAt: new Date(now.getTime() + PASSWORD_RESET_TTL_MS),
    });
    await this.mailService.sendPasswordReset(dto.email, token);
    await this.recordAudit(
      AuditAction.PasswordResetRequested,
      user.id,
      user.id,
      context,
      { email: dto.email },
    );
    return null;
  }

  async resetPassword(
    dto: ResetPasswordDto,
    context: AuthRequestContext,
  ): Promise<null> {
    const now = new Date();
    const stored = await this.passwordResetTokensRepository.findValidByHash(
      hashPasswordResetToken(dto.token),
      now,
    );
    if (!stored) {
      throw new ApiException(ErrorCode.PasswordResetInvalid);
    }

    const user = await this.authUsersRepository.findByIdWithPerson(
      stored.userId,
    );
    if (!user) {
      throw new ApiException(ErrorCode.PasswordResetInvalid);
    }

    const passwordHash = await this.hashService.hash(dto.newPassword);
    await this.authUsersRepository.updatePassword(user.id, passwordHash);
    await this.authUsersRepository.activateAfterPasswordReset(user.id);
    await this.passwordResetTokensRepository.markUsed(stored.id, now);
    await this.passwordResetTokensRepository.invalidateUnusedForUser(
      user.id,
      now,
    );
    await this.refreshTokenFamiliesRepository.revokeAllForUser(user.id, now);
    await this.recordAudit(
      AuditAction.PasswordReset,
      user.id,
      user.id,
      context,
      null,
    );
    return null;
  }

  async changePassword(
    user: AuthenticatedUser,
    dto: ChangePasswordDto,
    context: AuthRequestContext,
  ): Promise<null> {
    const dbUser = await this.authUsersRepository.findByIdWithPerson(user.id);
    if (!dbUser) {
      throw new ApiException(ErrorCode.Unauthorized);
    }

    const matches = await this.hashService.verify(
      dbUser.passwordHash,
      dto.currentPassword,
    );
    if (!matches) {
      throw new ApiException(ErrorCode.InvalidCredentials);
    }
    if (dto.currentPassword === dto.newPassword) {
      throw new ApiException(ErrorCode.PasswordPolicyViolation);
    }

    const passwordHash = await this.hashService.hash(dto.newPassword);
    const now = new Date();
    await this.authUsersRepository.updatePassword(user.id, passwordHash);
    await this.authUsersRepository.activateAfterPasswordReset(user.id);
    await this.refreshTokenFamiliesRepository.revokeAllForUser(user.id, now);
    await this.recordAudit(
      AuditAction.PasswordChanged,
      user.id,
      user.id,
      context,
      null,
    );
    return null;
  }

  private async issueSession(
    user: AppUser,
    context: AuthRequestContext,
    mfaMethod: MfaProofMethod | null = null,
  ): Promise<AuthenticatedLoginOutcome> {
    const [roles, scopes] = await Promise.all([
      this.authUsersRepository.findActiveRoleCodes(user.id),
      this.authUsersRepository.findActiveScopes(user.id),
    ]);
    const authenticatedUser = this.toAuthenticatedUser(user, roles, scopes);

    const familyId = randomUUID();
    const jti = randomUUID();
    const now = new Date();
    const expiresAt = this.refreshExpiryFrom(now);

    const refreshToken = this.tokenService.signRefreshToken(
      user.id,
      familyId,
      jti,
    );
    await this.refreshTokenFamiliesRepository.insert({
      id: familyId,
      userId: user.id,
      currentJti: jti,
      expiresAt,
      mfaVerifiedAt: mfaMethod ? now : null,
    });

    const accessToken = this.tokenService.signAccessToken({
      ...authenticatedUser,
      sessionId: familyId,
    });
    await this.authUsersRepository.markLoggedIn(user.id, now);
    await this.recordAudit(AuditAction.Login, user.id, user.id, context, {
      familyId,
      ...(mfaMethod ? { mfaMethod } : {}),
    });

    return {
      response: LoginResponseDto.from(
        accessToken,
        this.tokenService.getAccessTokenLifetimeSeconds(),
        user,
        roles,
      ),
      refreshToken,
    };
  }

  private async handleReuseDetected(
    family: RefreshTokenFamily,
    payload: RefreshTokenPayload,
    context: AuthRequestContext,
    reason: string,
  ): Promise<void> {
    await this.refreshTokenFamiliesRepository.revoke(family.id, new Date());
    await this.recordAudit(
      AuditAction.TokenReuseDetected,
      family.userId,
      family.userId,
      context,
      {
        familyId: family.id,
        presentedJti: payload.jti,
        reason,
      },
    );
  }

  private async findUserForLogin(identifier: string): Promise<AppUser | null> {
    if (identifier.includes('@')) {
      return this.authUsersRepository.findByEmailWithPerson(identifier);
    }
    return this.authUsersRepository.findByUsernameWithPerson(identifier);
  }

  private toAuthenticatedUser(
    user: AppUser,
    roles: ReadonlyArray<string>,
    scopes: AuthenticatedUser['scopes'],
  ): AuthenticatedUser {
    return {
      id: user.id,
      personId: user.personId,
      username: user.username,
      roles,
      scopes,
      mustChangePassword: user.mustChangePassword === true,
    };
  }

  private createPasswordResetToken(): {
    readonly token: string;
    readonly tokenHash: string;
  } {
    const token = randomBytes(32).toString('hex');
    return { token, tokenHash: hashPasswordResetToken(token) };
  }

  private assertAccountUsable(user: AppUser): void {
    if (user.status === UserStatus.Suspended) {
      throw new ApiException(ErrorCode.UserSuspended);
    }
    if (user.status === UserStatus.Inactive) {
      throw new ApiException(ErrorCode.UserInactive);
    }
    if (
      user.status === UserStatus.PendingActivation &&
      !user.mustChangePassword
    ) {
      throw new ApiException(ErrorCode.UserInactive);
    }
  }

  private refreshExpiryFrom(now: Date): Date {
    return new Date(
      now.getTime() + this.tokenService.getRefreshTokenLifetimeSeconds() * 1000,
    );
  }

  private async recordAudit(
    action: AuditAction,
    entityId: string,
    performedBy: string | null,
    context: AuthRequestContext,
    changes: Record<string, unknown> | null,
  ): Promise<void> {
    await this.auditLogsRepository.record({
      action,
      entityType: USER_ENTITY_TYPE,
      entityId,
      performedBy,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      ...(changes ? { changes } : {}),
    });
  }
}

export const hashPasswordResetToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export { requiresMfaEnrollment } from './mfa-policy.js';
