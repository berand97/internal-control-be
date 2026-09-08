import { Injectable } from '@nestjs/common';
import type { EffectivePermission } from '../types/effective-permission.type.js';

interface CacheEntry {
  readonly value: ReadonlyArray<EffectivePermission>;
  readonly expiresAt: number;
}

@Injectable()
export class PermissionsCache {
  private readonly entries = new Map<string, CacheEntry>();

  get(userId: string): ReadonlyArray<EffectivePermission> | null {
    const entry = this.entries.get(userId);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(userId);
      return null;
    }
    return entry.value;
  }

  set(
    userId: string,
    value: ReadonlyArray<EffectivePermission>,
    ttlSeconds: number,
  ): void {
    this.entries.set(userId, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  delete(userId: string): void {
    this.entries.delete(userId);
  }

  deleteMany(userIds: ReadonlyArray<string>): void {
    for (const userId of userIds) {
      this.entries.delete(userId);
    }
  }
}
