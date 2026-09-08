import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { ApiException } from '../exceptions/api.exception.js';
import { ErrorCode } from '../constants/error-code.enum.js';
import type { AuthenticatedUser } from '../types/authenticated-user.type.js';

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedUser }>();
    const user = request.user;
    if (!user) {
      throw new ApiException(ErrorCode.Unauthorized);
    }
    return user;
  },
);
