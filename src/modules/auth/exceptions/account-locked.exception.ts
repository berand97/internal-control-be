import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';

export class AccountLockedException extends ApiException {
  constructor(readonly retryAfterSeconds: number) {
    super(ErrorCode.AccountTemporarilyLocked);
    this.name = 'AccountLockedException';
  }

  static until(
    lockedUntil: Date | null,
    now: Date = new Date(),
  ): AccountLockedException {
    const remainingMs =
      (lockedUntil?.getTime() ?? now.getTime()) - now.getTime();
    return new AccountLockedException(
      Math.max(1, Math.ceil(remainingMs / 1000)),
    );
  }
}
