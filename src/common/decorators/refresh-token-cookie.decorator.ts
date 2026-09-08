import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { REFRESH_TOKEN_COOKIE_NAME } from '../constants/refresh-token-cookie.constant.js';

export const RefreshTokenCookie = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): string | undefined => {
    const request = ctx
      .switchToHttp()
      .getRequest<{ cookies?: Record<string, unknown> }>();
    const value = request.cookies?.[REFRESH_TOKEN_COOKIE_NAME];
    return typeof value === 'string' ? value : undefined;
  },
);
