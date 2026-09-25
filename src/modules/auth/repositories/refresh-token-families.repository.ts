import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RefreshTokenFamily } from '../entities/refresh-token-family.entity.js';
import { RefreshTokenFamilyStatus } from '../enums/refresh-token-family-status.enum.js';
import {
  NewRefreshTokenFamily,
  RefreshTokenFamiliesRepository,
  RotateRefreshTokenFamilyParams,
} from './refresh-token-families.repository.interface.js';

@Injectable()
export class TypeOrmRefreshTokenFamiliesRepository implements RefreshTokenFamiliesRepository {
  constructor(
    @InjectRepository(RefreshTokenFamily)
    private readonly families: Repository<RefreshTokenFamily>,
  ) {}

  findById(id: string): Promise<RefreshTokenFamily | null> {
    return this.families.findOne({ where: { id } });
  }

  async insert(family: NewRefreshTokenFamily): Promise<void> {
    await this.families.insert({
      id: family.id,
      userId: family.userId,
      status: RefreshTokenFamilyStatus.Active,
      currentJti: family.currentJti,
      expiresAt: family.expiresAt,
      revokedAt: null,
      mfaVerifiedAt: family.mfaVerifiedAt ?? null,
    });
  }

  async rotate(params: RotateRefreshTokenFamilyParams): Promise<boolean> {
    const result = await this.families
      .createQueryBuilder()
      .update(RefreshTokenFamily)
      .set({ currentJti: params.newJti, expiresAt: params.expiresAt })
      .where('id = :id', { id: params.id })
      .andWhere('current_jti = :expectedJti', {
        expectedJti: params.expectedJti,
      })
      .andWhere('status = :status', { status: RefreshTokenFamilyStatus.Active })
      .execute();
    return result.affected === 1;
  }

  async revoke(id: string, at: Date): Promise<void> {
    await this.families
      .createQueryBuilder()
      .update(RefreshTokenFamily)
      .set({ status: RefreshTokenFamilyStatus.Revoked, revokedAt: at })
      .where('id = :id', { id })
      .andWhere('status = :status', { status: RefreshTokenFamilyStatus.Active })
      .execute();
  }

  async revokeAllForUser(userId: string, at: Date): Promise<number> {
    const result = await this.families
      .createQueryBuilder()
      .update(RefreshTokenFamily)
      .set({ status: RefreshTokenFamilyStatus.Revoked, revokedAt: at })
      .where('user_id = :userId', { userId })
      .andWhere('status = :status', { status: RefreshTokenFamilyStatus.Active })
      .execute();
    return result.affected ?? 0;
  }
}
