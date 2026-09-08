import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, MoreThan, Repository } from 'typeorm';
import { PasswordResetToken } from '../entities/password-reset-token.entity.js';
import type {
  NewPasswordResetToken,
  PasswordResetTokensRepository,
} from './password-reset-tokens.repository.interface.js';

@Injectable()
export class TypeOrmPasswordResetTokensRepository
  implements PasswordResetTokensRepository
{
  constructor(
    @InjectRepository(PasswordResetToken)
    private readonly tokens: Repository<PasswordResetToken>,
  ) {}

  async insert(token: NewPasswordResetToken): Promise<void> {
    await this.tokens.insert({
      userId: token.userId,
      tokenHash: token.tokenHash,
      expiresAt: token.expiresAt,
    });
  }

  findValidByHash(
    tokenHash: string,
    now: Date,
  ): Promise<PasswordResetToken | null> {
    return this.tokens.findOne({
      where: {
        tokenHash,
        usedAt: IsNull(),
        expiresAt: MoreThan(now),
      },
    });
  }

  async markUsed(id: string, at: Date): Promise<void> {
    await this.tokens.update({ id }, { usedAt: at });
  }

  async invalidateUnusedForUser(userId: string, at: Date): Promise<void> {
    await this.tokens.update(
      { userId, usedAt: IsNull() },
      { usedAt: at },
    );
  }
}
