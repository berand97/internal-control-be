import type { PasswordResetToken } from '../entities/password-reset-token.entity.js';

export interface NewPasswordResetToken {
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

export interface PasswordResetTokensRepository {
  insert(token: NewPasswordResetToken): Promise<void>;
  findValidByHash(
    tokenHash: string,
    now: Date,
  ): Promise<PasswordResetToken | null>;
  markUsed(id: string, at: Date): Promise<void>;
  invalidateUnusedForUser(userId: string, at: Date): Promise<void>;
}
