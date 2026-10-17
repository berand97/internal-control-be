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

const THROTTLER_LIMIT = 'THROTTLER:LIMIT';

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
