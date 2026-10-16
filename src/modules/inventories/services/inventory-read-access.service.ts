import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import { PermissionsService } from '../../roles/services/permissions.service.js';

const ASSET_READ_GLOBAL = 'asset:read:global';
const ASSET_READ_SCOPED = 'asset:read:org_unit';

@Injectable()
export class InventoryReadAccess {
  constructor(
    private readonly dataSource: DataSource,
    private readonly permissions: PermissionsService,
  ) {}

  async assertReadable(inventoryId: string, userId: string): Promise<void> {
    const scope = await this.permissions.costCenterScope(userId, ASSET_READ_GLOBAL, ASSET_READ_SCOPED);
    if (scope.kind === 'GLOBAL') {
      return;
    }
    const centers = scope.kind === 'COST_CENTERS' ? [...scope.costCenterIds] : [];
    const [row] = (await this.dataSource.query(
      `SELECT 1 FROM physical_inventory i
       WHERE i.id = $1
         AND (i.responsible_user_id = $2 OR i.created_by = $2
              OR (i.scope_type = 'COST_CENTER' AND i.scope_id = ANY($3::uuid[])
                  AND NOT EXISTS (SELECT 1 FROM physical_inventory_scope s WHERE s.inventory_id = i.id AND NOT (s.cost_center_id = ANY($3::uuid[])))))`,
      [inventoryId, userId, centers],
    )) as unknown[];
    if (!row) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
  }
}
