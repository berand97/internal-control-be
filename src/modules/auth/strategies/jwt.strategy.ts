import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import passportJwt from 'passport-jwt';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import type { AppConfig } from '../../../config/configuration.js';
import { isAccessTokenPayload } from '../types/token-payloads.type.js';

const { ExtractJwt, Strategy } = passportJwt;

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(config: ConfigService<AppConfig, true>) {
    const jwtConfig = config.getOrThrow('jwt', { infer: true });
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: jwtConfig.accessSecret,
      issuer: jwtConfig.issuer,
      audience: jwtConfig.audience,
    });
  }

  validate(payload: unknown): AuthenticatedUser {
    if (!isAccessTokenPayload(payload)) {
      throw new ApiException(ErrorCode.Unauthorized);
    }
    return {
      id: payload.sub,
      personId: payload.personId,
      username: payload.username,
      roles: payload.roles,
      scopes: payload.scopes,
      mustChangePassword: payload.mustChangePassword === true,
      sessionId: payload.sid ?? null,
    };
  }
}
