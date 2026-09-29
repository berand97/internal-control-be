import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerRequest,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { AppConfig } from '../../config/configuration.js';
import { TokenService } from '../../modules/auth/services/token.service.js';

/** Metadato que deja @Throttle(...) en la ruta o el controlador (constante interna de @nestjs/throttler). */
const THROTTLER_LIMIT = 'THROTTLER:LIMIT';

/**
 * Límite de peticiones por usuario autenticado y por IP para el resto (ver throttle-limits.ts):
 * - Ruta o controlador con @Throttle propio (login, MFA, recuperación, enlaces de firma, verificación pública): igual
 *   que antes, por IP y con su límite.
 * - Con access token válido (firma, vigencia y sesión sid; TokenService.accessTokenSubject): cupo del usuario
 *   (THROTTLE_USER_LIMIT) contado por su id, sin importar la IP.
 * - Sin token válido: por IP (req.ip respeta TRUST_PROXY) con el límite general.
 * La clave sigue siendo por ruta (generateKey de ThrottlerGuard) y el 429 sigue trayendo Retry-After.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  private readonly userLimit: number;

  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly tokens: TokenService,
    config: ConfigService<AppConfig, true>,
  ) {
    super(options, storageService, reflector);
    this.userLimit = config.getOrThrow('throttleUserLimit', { infer: true });
  }

  protected override async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    const { context, throttler } = requestProps;
    const strict = this.reflector.getAllAndOverride<unknown>(`${THROTTLER_LIMIT}${throttler.name ?? 'default'}`, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (strict !== undefined) {
      return super.handleRequest(requestProps);
    }
    const { req } = this.getRequestResponse(context);
    const header = (req['headers'] as Record<string, unknown> | undefined)?.['authorization'];
    const userId = this.tokens.accessTokenSubject(typeof header === 'string' ? header : undefined);
    if (userId === null) {
      return super.handleRequest(requestProps);
    }
    return super.handleRequest({
      ...requestProps,
      limit: this.userLimit,
      getTracker: () => Promise.resolve(`user:${userId}`),
    });
  }
}
