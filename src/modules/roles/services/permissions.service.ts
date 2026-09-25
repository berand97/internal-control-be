import { Inject, Injectable } from '@nestjs/common';
import type { PermissionsRepository } from '../repositories/permissions.repository.interface.js';
import type {
  EffectivePermission,
  PermissionScope,
} from '../types/effective-permission.type.js';
import {
  type CostCenterScope,
  resolveCostCenterScope,
} from './cost-center-scope.js';
import { PermissionsCache } from './permissions-cache.service.js';

const CACHE_TTL_SECONDS = 60;

@Injectable()
export class PermissionsService {
  constructor(
    @Inject('PermissionsRepository')
    private readonly repository: PermissionsRepository,
    private readonly cache: PermissionsCache,
  ) {}

  async userHasPermission(
    userId: string,
    permissionCode: string,
    scope?: PermissionScope,
  ): Promise<boolean> {
    const permissions = await this.getEffectivePermissions(userId);
    return permissions.some((permission) => {
      if (permission.permissionCode !== permissionCode) {
        return false;
      }
      // El alcance de adscripción (depto/centro) no anula un permiso :global
      // del rol. Sin esto, un director adscrito no puede listar tomas físicas.
      if (
        permission.permissionCode.endsWith(':global') ||
        permission.userScopeType === 'GLOBAL'
      ) {
        return true;
      }
      if (!scope) {
        return false;
      }
      if (permission.userScopeType !== scope.type) {
        return false;
      }
      if (permission.userScopeId === null) {
        return true;
      }
      return permission.userScopeId === scope.id;
    });
  }

  /**
   * Centros de costo sobre los que el usuario puede usar `scopedCode`, o
   * GLOBAL si tiene `globalCode`. Genérico por código de permiso: lo usan la
   * lectura de activos y lo reutilizará la aprobación de préstamos.
   */
  async costCenterScope(
    userId: string,
    globalCode: string,
    scopedCode: string,
  ): Promise<CostCenterScope> {
    return resolveCostCenterScope(
      await this.getEffectivePermissions(userId),
      globalCode,
      scopedCode,
    );
  }

  async getEffectivePermissions(
    userId: string,
  ): Promise<ReadonlyArray<EffectivePermission>> {
    const cached = this.cache.get(userId);
    if (cached) {
      return cached;
    }
    const fresh = await this.repository.findEffectivePermissions(userId);
    this.cache.set(userId, fresh, CACHE_TTL_SECONDS);
    return fresh;
  }

  invalidate(userId: string): void {
    this.cache.delete(userId);
  }

  invalidateMany(userIds: ReadonlyArray<string>): void {
    this.cache.deleteMany(userIds);
  }
}
