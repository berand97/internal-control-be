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
      if (permission.permissionCode.endsWith(':own')) {
        return true;
      }
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

  async costCenterScope(
    userId: string,
    globalCode: string,
    scopedCode: string,
  ): Promise<CostCenterScope> {
    const permissions = await this.getEffectivePermissions(userId);
    const base = resolveCostCenterScope(permissions, globalCode, scopedCode);
    if (base.kind === 'GLOBAL' || base.kind === 'DENIED') {
      return base;
    }
    const extra = [
      ...(await this.getHeadedCostCenterIds(userId)),
      ...(await this.getOrgUnitCostCenterIds(permissions, scopedCode)),
    ];
    return resolveCostCenterScope(permissions, globalCode, scopedCode, extra);
  }

  private async getHeadedCostCenterIds(
    userId: string,
  ): Promise<ReadonlyArray<string>> {
    const cached = this.cache.getHeadedCostCenters(userId);
    if (cached) {
      return cached;
    }
    const fresh = await this.repository.findHeadedCostCenterIds(userId);
    this.cache.setHeadedCostCenters(userId, fresh, CACHE_TTL_SECONDS);
    return fresh;
  }

  private async getOrgUnitCostCenterIds(
    permissions: ReadonlyArray<EffectivePermission>,
    scopedCode: string,
  ): Promise<ReadonlyArray<string>> {
    const orgUnitIds = [
      ...new Set(
        permissions.flatMap((permission) =>
          permission.permissionCode === scopedCode &&
          permission.userScopeType === 'ORG_UNIT' &&
          permission.userScopeId
            ? [permission.userScopeId]
            : [],
        ),
      ),
    ];
    if (orgUnitIds.length === 0) {
      return [];
    }
    return this.repository.findCostCenterIdsUnderOrgUnits(orgUnitIds);
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
