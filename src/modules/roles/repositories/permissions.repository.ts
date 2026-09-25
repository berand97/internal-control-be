import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { isTokenScopeType } from '../../../common/types/authenticated-user.type.js';
import type { PermissionsRepository } from './permissions.repository.interface.js';
import type { EffectivePermission } from '../types/effective-permission.type.js';

interface EffectivePermissionRow {
  readonly permission_code: string;
  readonly user_scope_type: string;
  readonly user_scope_id: string | null;
}

@Injectable()
export class TypeOrmPermissionsRepository implements PermissionsRepository {
  constructor(private readonly dataSource: DataSource) {}

  async findEffectivePermissions(
    userId: string,
  ): Promise<ReadonlyArray<EffectivePermission>> {
    const rows = await this.dataSource.query<EffectivePermissionRow[]>(
      `
      SELECT permission_code, user_scope_type, user_scope_id
      FROM v_user_effective_permissions
      WHERE user_id = $1
      `,
      [userId],
    );
    return rows.flatMap((row): ReadonlyArray<EffectivePermission> => {
      if (!isTokenScopeType(row.user_scope_type)) {
        return [];
      }
      return [
        {
          permissionCode: row.permission_code,
          userScopeType: row.user_scope_type,
          userScopeId: row.user_scope_id,
        },
      ];
    });
  }

  async findHeadedCostCenterIds(userId: string): Promise<ReadonlyArray<string>> {
    const rows = await this.dataSource.query<Array<{ cost_center_id: string }>>(
      `
      SELECT DISTINCT h.cost_center_id
      FROM app_user u
      JOIN cost_center_head h ON h.person_id = u.person_id
      WHERE u.id = $1
        AND h.valid_from <= NOW()
        AND (h.valid_until IS NULL OR h.valid_until > NOW())
      ORDER BY h.cost_center_id
      `,
      [userId],
    );
    return rows.map((row) => row.cost_center_id);
  }
}
