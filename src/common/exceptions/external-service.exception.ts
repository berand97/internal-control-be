import { ErrorCode } from '../constants/error-code.enum.js';
import { ApiException } from './api.exception.js';

export class ExternalServiceException extends ApiException {
  constructor(
    message: string,
    code: ErrorCode = ErrorCode.ExternalServiceFailure,
  ) {
    super(code, message);
    this.name = 'ExternalServiceException';
  }
}
