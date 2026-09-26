import { Injectable } from '@nestjs/common';
import type { EffectivePermission } from '../types/effective-permission.type.js';

interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

/**
 * Caché por usuario de sus permisos efectivos y de los centros de costo que dirige (cost_center_head). Invalidar
 * a un usuario borra ambas cosas: asignar o terminar una jefatura se ve de inmediato.
 */
@Injectable()
export class PermissionsCache {
  private readonly entries = new Map<string, CacheEntry<ReadonlyArray<EffectivePermission>>>();
  private readonly headed = new Map<string, CacheEntry<ReadonlyArray<string>>>();

  get(userId: string): ReadonlyArray<EffectivePermission> | null {
    return this.read(this.entries, userId);
  }

  set(
    userId: string,
    value: ReadonlyArray<EffectivePermission>,
    ttlSeconds: number,
  ): void {
    this.entries.set(userId, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  getHeadedCostCenters(userId: string): ReadonlyArray<string> | null {
    return this.read(this.headed, userId);
  }

  setHeadedCostCenters(userId: string, value: ReadonlyArray<string>, ttlSeconds: number): void {
    this.headed.set(userId, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  delete(userId: string): void {
    this.entries.delete(userId);
    this.headed.delete(userId);
  }

  deleteMany(userIds: ReadonlyArray<string>): void {
    for (const userId of userIds) {
      this.delete(userId);
    }
  }

  private read<T>(map: Map<string, CacheEntry<T>>, userId: string): T | null {
    const entry = map.get(userId);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= Date.now()) {
      map.delete(userId);
      return null;
    }
    return entry.value;
  }
}
