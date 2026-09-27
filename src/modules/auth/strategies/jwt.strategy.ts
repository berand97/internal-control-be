import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import passportJwt from 'passport-jwt';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import type { AppConfig } from '../../../config/configuration.js';
import { SessionStateService } from '../services/session-state.service.js';
import { isAccessTokenPayload } from '../types/token-payloads.type.js';

const { ExtractJwt, Strategy } = passportJwt;

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService<AppConfig, true>,
    private readonly sessions: SessionStateService,
  ) {
    const jwtConfig = config.getOrThrow('jwt', { infer: true });
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: jwtConfig.accessSecret,
      issuer: jwtConfig.issuer,
      audience: jwtConfig.audience,
    });
  }

  /**
   * La firma y el vencimiento no bastan (BE-09): la sesión (sid) debe seguir activa y la cuenta utilizable. Un token
   * sin sid no se acepta: todo access token emitido por AuthService lleva la familia de refresh de su sesión.
   * mustChangePassword sale de la BD, no del token.
   */
  async validate(payload: unknown): Promise<AuthenticatedUser> {
    if (!isAccessTokenPayload(payload)) {
      throw new ApiException(ErrorCode.Unauthorized);
    }
    if (!payload.sid) {
      throw new ApiException(ErrorCode.SessionRevoked);
    }
    const live = await this.sessions.resolve(payload.sub, payload.sid);
    if (!live) {
      throw new ApiException(ErrorCode.SessionRevoked);
    }
    return {
      id: payload.sub,
      personId: payload.personId,
      username: payload.username,
      roles: payload.roles,
      scopes: payload.scopes,
      mustChangePassword: live.mustChangePassword,
      sessionId: payload.sid,
    };
  }
}
