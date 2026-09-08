import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ERROR_CATALOG,
  ErrorCatalogEntry,
} from '../constants/error-catalog.js';
import { ErrorCode } from '../constants/error-code.enum.js';
import {
  REFRESH_TOKEN_COOKIE_NAME,
  REFRESH_TOKEN_COOKIE_PATH,
} from '../constants/refresh-token-cookie.constant.js';
import { ApiException } from '../exceptions/api.exception.js';
import type { AuthenticatedRequest } from '../types/authenticated-request.type.js';
import type {
  ErrorDetail,
  ResponseAction,
} from '../types/response-envelope.type.js';

interface ResolvedError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly action: ResponseAction;
  readonly details?: ReadonlyArray<ErrorDetail>;
}

const STATUS_FALLBACK_CODES: Readonly<Record<number, ErrorCode>> = {
  400: ErrorCode.MalformedRequest,
  401: ErrorCode.Unauthorized,
  403: ErrorCode.InsufficientPermissions,
  404: ErrorCode.ResourceNotFound,
  406: ErrorCode.InvalidState,
  409: ErrorCode.ConcurrentModification,
  424: ErrorCode.ExternalServiceFailure,
  429: ErrorCode.TooManyAttempts,
};

const isValidationResponseBody = (
  value: unknown,
): value is { message: ReadonlyArray<string> } =>
  typeof value === 'object' &&
  value !== null &&
  'message' in value &&
  Array.isArray((value as { message: unknown }).message);

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<AuthenticatedRequest>();

    const resolved = this.resolveError(exception);

    if (resolved.status >= 500) {
      this.logger.error(
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    if (
      resolved.status === 401 &&
      request.path === `${REFRESH_TOKEN_COOKIE_PATH}/refresh`
    ) {
      response.clearCookie(REFRESH_TOKEN_COOKIE_NAME, {
        path: REFRESH_TOKEN_COOKIE_PATH,
      });
    }

    const details = resolved.details;
    response.status(resolved.status).json({
      error: {
        message: resolved.message,
        code: resolved.code,
        ...(details ? { details } : {}),
      },
      type: 'ERROR',
      action: resolved.action,
    });
  }

  private resolveError(exception: unknown): ResolvedError {
    if (exception instanceof ApiException) {
      const entry: ErrorCatalogEntry = ERROR_CATALOG[exception.code];
      return {
        status: entry.httpStatus,
        code: exception.code,
        message: exception.message,
        action: entry.action,
        ...(exception.details ? { details: exception.details } : {}),
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = STATUS_FALLBACK_CODES[status] ?? ErrorCode.InternalError;
      const entry = ERROR_CATALOG[code];
      const body = exception.getResponse();

      if (status === 400 && isValidationResponseBody(body)) {
        return {
          status,
          code: ErrorCode.ValidationFailed,
          message: ERROR_CATALOG[ErrorCode.ValidationFailed].message,
          action: ERROR_CATALOG[ErrorCode.ValidationFailed].action,
          details: body.message.map((message) => ({
            field: 'request',
            message,
          })),
        };
      }

      return {
        status,
        code,
        message: entry.message,
        action: entry.action,
      };
    }

    return {
      status: 500,
      code: ErrorCode.InternalError,
      message: ERROR_CATALOG[ErrorCode.InternalError].message,
      action: ERROR_CATALOG[ErrorCode.InternalError].action,
    };
  }
}
