import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import jwt from 'jsonwebtoken';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AppConfig } from '../../../config/configuration.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import {
  isMfaChallengeTokenPayload,
  isMfaSetupTokenPayload,
  isRefreshTokenPayload,
  MfaChallengeTokenPayload,
  MfaSetupTokenPayload,
  RefreshTokenPayload,
} from '../types/token-payloads.type.js';

const BEARER_PREFIX = 'Bearer ';

@Injectable()
export class TokenService {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  getIssuer(): string {
    return this.config.getOrThrow('jwt.issuer', { infer: true });
  }

  getAccessTokenLifetimeSeconds(): number {
    return this.config.getOrThrow('jwt.accessExpiresInSeconds', {
      infer: true,
    });
  }

  getRefreshTokenLifetimeSeconds(): number {
    return this.config.getOrThrow('jwt.refreshExpiresInSeconds', {
      infer: true,
    });
  }

  signAccessToken(user: AuthenticatedUser): string {
    const jwtConfig = this.config.getOrThrow('jwt', { infer: true });
    return jwt.sign(
      {
        type: 'access',
        sub: user.id,
        personId: user.personId,
        username: user.username,
        roles: user.roles,
        scopes: user.scopes,
        mustChangePassword: user.mustChangePassword === true,
        ...(user.sessionId ? { sid: user.sessionId } : {}),
      },
      jwtConfig.accessSecret,
      {
        expiresIn: jwtConfig.accessExpiresInSeconds,
        issuer: jwtConfig.issuer,
        audience: jwtConfig.audience,
      },
    );
  }

  signRefreshToken(userId: string, familyId: string, jti: string): string {
    const jwtConfig = this.config.getOrThrow('jwt', { infer: true });
    return jwt.sign(
      { type: 'refresh', sub: userId, familyId, jti },
      jwtConfig.refreshSecret,
      {
        expiresIn: jwtConfig.refreshExpiresInSeconds,
      },
    );
  }

  signMfaSetupToken(userId: string, username: string): string {
    const jwtConfig = this.config.getOrThrow('jwt', { infer: true });
    return jwt.sign(
      { type: 'mfa_setup', sub: userId, username },
      jwtConfig.accessSecret,
      {
        expiresIn: jwtConfig.mfaChallengeExpiresInSeconds,
        issuer: jwtConfig.issuer,
        audience: jwtConfig.audience,
      },
    );
  }

  signMfaChallengeToken(userId: string, username: string): string {
    const jwtConfig = this.config.getOrThrow('jwt', { infer: true });
    return jwt.sign(
      { type: 'mfa_challenge', sub: userId, username },
      jwtConfig.accessSecret,
      {
        expiresIn: jwtConfig.mfaChallengeExpiresInSeconds,
        issuer: jwtConfig.issuer,
        audience: jwtConfig.audience,
      },
    );
  }

  verifyRefreshToken(token: string): RefreshTokenPayload {
    const jwtConfig = this.config.getOrThrow('jwt', { infer: true });
    let decoded: unknown;
    try {
      decoded = jwt.verify(token, jwtConfig.refreshSecret);
    } catch {
      throw new ApiException(ErrorCode.TokenExpired);
    }
    if (!isRefreshTokenPayload(decoded)) {
      throw new ApiException(ErrorCode.TokenExpired);
    }
    return decoded;
  }

  verifyMfaChallengeToken(
    authorizationHeader: string | undefined,
  ): MfaChallengeTokenPayload {
    if (
      authorizationHeader === undefined ||
      !authorizationHeader.startsWith(BEARER_PREFIX)
    ) {
      throw new ApiException(ErrorCode.MfaRequired);
    }
    const token = authorizationHeader.slice(BEARER_PREFIX.length);
    const jwtConfig = this.config.getOrThrow('jwt', { infer: true });
    let decoded: unknown;
    try {
      decoded = jwt.verify(token, jwtConfig.accessSecret, {
        issuer: jwtConfig.issuer,
        audience: jwtConfig.audience,
      });
    } catch {
      throw new ApiException(ErrorCode.MfaRequired);
    }
    if (!isMfaChallengeTokenPayload(decoded)) {
      throw new ApiException(ErrorCode.MfaRequired);
    }
    return decoded;
  }

  verifyMfaSetupToken(
    authorizationHeader: string | undefined,
  ): MfaSetupTokenPayload {
    if (
      authorizationHeader === undefined ||
      !authorizationHeader.startsWith(BEARER_PREFIX)
    ) {
      throw new ApiException(ErrorCode.MfaRequired);
    }
    const token = authorizationHeader.slice(BEARER_PREFIX.length);
    const jwtConfig = this.config.getOrThrow('jwt', { infer: true });
    let decoded: unknown;
    try {
      decoded = jwt.verify(token, jwtConfig.accessSecret, {
        issuer: jwtConfig.issuer,
        audience: jwtConfig.audience,
      });
    } catch {
      throw new ApiException(ErrorCode.MfaRequired);
    }
    if (!isMfaSetupTokenPayload(decoded)) {
      throw new ApiException(ErrorCode.MfaRequired);
    }
    return decoded;
  }
}
