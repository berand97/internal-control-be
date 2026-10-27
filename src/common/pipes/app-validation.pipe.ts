import { ValidationPipe } from '@nestjs/common';
import type { ValidationError } from 'class-validator';
import { ErrorCode } from '../constants/error-code.enum.js';
import { ApiException } from '../exceptions/api.exception.js';
import type { ErrorDetail } from '../types/response-envelope.type.js';
import { translateConstraint } from './validation-messages.js';

const flattenValidationErrors = (
  errors: ReadonlyArray<ValidationError>,
): ReadonlyArray<ErrorDetail> =>
  errors.flatMap((error): ReadonlyArray<ErrorDetail> => {
    const ownConstraints = error.constraints
      ? Object.entries(error.constraints).map(([constraint, message]): ErrorDetail => ({
          field: error.property,
          message: translateConstraint(constraint, message, error.property),
        }))
      : [];
    const children = error.children
      ? flattenValidationErrors(error.children)
      : [];
    return [...ownConstraints, ...children];
  });

export const createAppValidationPipe = (): ValidationPipe =>
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors: ReadonlyArray<ValidationError>) =>
      new ApiException(
        ErrorCode.ValidationFailed,
        undefined,
        flattenValidationErrors(errors),
      ),
  });
