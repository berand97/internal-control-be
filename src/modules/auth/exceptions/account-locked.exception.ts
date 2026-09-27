import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';

/**
 * Bloqueo temporal por cuenta (auth_attempt_lockout): 429 ACCOUNT_TEMPORARILY_LOCKED con Retry-After. Distinto de
 * TOO_MANY_ATTEMPTS, que queda solo para el throttler por IP. Una cuenta inexistente se bloquea con el mismo
 * contador y el mismo plazo, así que ni el código ni Retry-After revelan si existe.
 */
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
