import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { catchError, Observable, tap, throwError } from 'rxjs';
import { ERROR_CATALOG } from '../constants/error-catalog.js';
import { FEATURE_CODE_KEY } from '../decorators/feature.decorator.js';
import { ApiException } from '../exceptions/api.exception.js';
import { featureCodesForPath } from '../../modules/features/feature-catalog.js';
import { FeatureFlagsService } from '../../modules/features/services/feature-flags.service.js';
import type { AuthenticatedRequest } from '../types/authenticated-request.type.js';

@Injectable()
export class FeatureCircuitInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly featureFlags: FeatureFlagsService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const code = this.resolveCode(context);
    if (!code) {
      return next.handle();
    }

    // Las promesas no se esperan (no frenan la respuesta) y no rechazan: el servicio registra sus propios errores.
    return next.handle().pipe(
      tap(() => {
        void this.featureFlags.recordSuccess(code);
      }),
      catchError((error: unknown) => {
        if (isCircuitFailure(error)) {
          void this.featureFlags.recordFailure(code);
        } else {
          // 4xx: no dice nada de la salud del módulo; si era la petición de prueba, otra probará.
          this.featureFlags.releaseProbe(code);
        }
        return throwError(() => error);
      }),
    );
  }

  private resolveCode(context: ExecutionContext): string | undefined {
    const decorated = this.reflector.getAllAndOverride<string | undefined>(
      FEATURE_CODE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (decorated) {
      return decorated;
    }
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    return featureCodesForPath(request.path ?? '')[0];
  }
}

const isCircuitFailure = (error: unknown): boolean => {
  if (error instanceof ApiException) {
    return ERROR_CATALOG[error.code].httpStatus >= 500;
  }
  if (error instanceof HttpException) {
    return error.getStatus() >= 500;
  }
  return true;
};
