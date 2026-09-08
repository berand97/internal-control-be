import { ErrorCode } from '../constants/error-code.enum.js';
import { ApiException } from './api.exception.js';

export class BusinessRuleException extends ApiException {
  constructor(message: string, code: ErrorCode = ErrorCode.InvalidState) {
    super(code, message);
    this.name = 'BusinessRuleException';
  }
}
