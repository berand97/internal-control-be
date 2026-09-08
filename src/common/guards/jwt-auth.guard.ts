import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import jsonwebtoken from 'jsonwebtoken';
import type { Observable } from 'rxjs';
import { ErrorCode } from '../constants/error-code.enum.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import { ApiException } from '../exceptions/api.exception.js';

const { TokenExpiredError } = jsonwebtoken;

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }
    return super.canActivate(context);
  }

  handleRequest<TUser>(err: unknown, user: TUser, info: unknown): TUser {
    if (err instanceof Error) {
      throw new ApiException(ErrorCode.Unauthorized, err.message);
    }
    if (!user) {
      if (info instanceof TokenExpiredError) {
        throw new ApiException(ErrorCode.TokenExpired);
      }
      throw new ApiException(ErrorCode.Unauthorized);
    }
    return user;
  }
}
