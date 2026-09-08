import type { RefreshTokenFamily } from '../entities/refresh-token-family.entity.js';

export interface NewRefreshTokenFamily {
  readonly id: string;
  readonly userId: string;
  readonly currentJti: string;
  readonly expiresAt: Date;
}

export interface RotateRefreshTokenFamilyParams {
  readonly id: string;
  readonly expectedJti: string;
  readonly newJti: string;
  readonly expiresAt: Date;
}

export interface RefreshTokenFamiliesRepository {
  findById(id: string): Promise<RefreshTokenFamily | null>;
  insert(family: NewRefreshTokenFamily): Promise<void>;
  rotate(params: RotateRefreshTokenFamilyParams): Promise<boolean>;
  revoke(id: string, at: Date): Promise<void>;
  revokeAllForUser(userId: string, at: Date): Promise<number>;
}
