import { ERROR_CATALOG } from '../constants/error-catalog.js';
import { ErrorCode } from '../constants/error-code.enum.js';
import type { ErrorDetail } from '../types/response-envelope.type.js';

export class ApiException extends Error {
  constructor(
    readonly code: ErrorCode,
    message?: string,
    readonly details?: ReadonlyArray<ErrorDetail>,
  ) {
    super(message ?? ERROR_CATALOG[code].message);
    this.name = 'ApiException';
  }
}
