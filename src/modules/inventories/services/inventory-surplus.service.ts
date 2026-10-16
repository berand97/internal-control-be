import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { AssetsService } from '../../assets/services/assets.service.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import { PermissionsService } from '../../roles/services/permissions.service.js';
import type { ResolveSurplusDto } from '../dto/inventory-reconciliation.dto.js';
import { PhysicalInventory } from '../entities/physical-inventory.entity.js';
import { PhysicalInventoryItem } from '../entities/physical-inventory-item.entity.js';
import { InventoryScopeType } from '../enums/inventory-scope.js';
import { InventoryStatus } from '../enums/inventory-status.js';
import { VerificationResult } from '../enums/verification-result.js';
import { InventoryActorPolicy } from './inventory-actor-policy.service.js';
import { toItemView } from './inventory-item-view.js';
import { InventorySignerHeadService } from './inventory-signer-head.service.js';
import { InventoryValuationService } from './inventory-valuation.service.js';

const ASSET_CREATE_PERMISSION = 'asset:create:global';

@Injectable()
export class InventorySurplusService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly actorPolicy: InventoryActorPolicy,
    private readonly permissions: PermissionsService,
    private readonly assets: AssetsService,
    private readonly valuation: InventoryValuationService,
    private readonly signerHead: InventorySignerHeadService,
    @Inject('AuditLogsRepository')
    private readonly auditLogs: AuditLogsRepository,
  ) {}

  async resolve(inventoryId: string, itemId: string, dto: ResolveSurplusDto, actor: AuthenticatedUser) {
    const inventory = await this.dataSource.getRepository(PhysicalInventory).findOne({ where: { id: inventoryId } });
    if (!inventory) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    if (inventory.status !== InventoryStatus.Closed) {
      throw new ApiException(
        ErrorCode.InvalidState,
        'Los sobrantes se resuelven con la toma cerrada y antes de aprobar la conciliación',
      );
    }
    await this.actorPolicy.assertCanOperate(inventory, actor);
    if (dto.action === 'CREATE_ASSET') {
      if (!dto.asset) {
        throw new ApiException(ErrorCode.ValidationFailed, undefined, [
          { field: 'asset', message: 'CREATE_ASSET necesita los datos del activo' },
        ]);
      }
      if (!(await this.permissions.userHasPermission(actor.id, ASSET_CREATE_PERMISSION))) {
        throw new ApiException(ErrorCode.InsufficientPermissions, 'Registrar el activo exige asset:create:global');
      }
    }
    if (dto.costCenterId && inventory.scopeType !== InventoryScopeType.CostCenter) {
      await this.assertCenterAcceptsAssets(dto.costCenterId);
    }

    const item = await this.dataSource.transaction(async (manager) => {
      const items = manager.getRepository(PhysicalInventoryItem);
      const found = await items.findOne({
        where: { id: itemId, inventoryId: inventory.id },
        lock: { mode: 'pessimistic_write' },
      });
      const [current] = (await manager.query('SELECT status FROM physical_inventory WHERE id = $1 FOR SHARE', [
        inventory.id,
      ])) as Array<{ status: InventoryStatus }>;
      if (current?.status !== InventoryStatus.Closed) {
        throw new ApiException(ErrorCode.InvalidState);
      }
      this.assertResolvable(found);
      const target = found as PhysicalInventoryItem;
      const now = new Date();
      const costCenterId = this.costCenterFor(inventory, dto.costCenterId ?? target.surplusCostCenterId ?? undefined, dto.action);
      if (dto.action === 'LEAVE_UNRESOLVED' && inventory.scopeType !== InventoryScopeType.CostCenter) {
        target.surplusCostCenterId = costCenterId;
      }
      if (dto.action === 'CREATE_ASSET' && dto.asset) {
        const observedCondition = dto.asset.physicalCondition ?? target.actualCondition;
        const created = await this.assets.createWithin(
          manager,
          {
            description: dto.asset.description,
            categoryId: dto.asset.categoryId,
            costCenterId,
            acquisitionTypeId: dto.asset.acquisitionTypeId,
            acquisitionDate: dto.asset.acquisitionDate,
            ...(dto.asset.acquisitionPrice !== undefined ? { acquisitionPrice: dto.asset.acquisitionPrice } : {}),
            ...(dto.asset.serialNumber ? { serialNumber: dto.asset.serialNumber } : {}),
            ...(dto.asset.model ? { model: dto.asset.model } : {}),
            ...(dto.asset.acquisitionDocument ? { acquisitionDocument: dto.asset.acquisitionDocument } : {}),
            ...(dto.asset.photoUrl ? { photoUrl: dto.asset.photoUrl } : {}),
            ...(dto.asset.notes ? { notes: dto.asset.notes } : {}),
            ...((dto.asset.locationId ?? target.actualLocationId)
              ? { locationId: dto.asset.locationId ?? (target.actualLocationId as string) }
              : {}),
            ...(observedCondition ? { physicalCondition: observedCondition } : {}),
          },
          actor,
          {
            reason: `Alta por sobrante de la toma ${inventory.code}: ${dto.reason}`.slice(0, 500),
            documentReference: inventory.code,
            metadata: { inventoryId: inventory.id, inventoryItemId: target.id },
            auditChanges: { inventoryId: inventory.id, inventoryItemId: target.id },
          },
        );
        target.resolvedAssetId = created.id;
      }
      const previous = target.surplusResolution ?? null;
      target.surplusResolution = dto.action;
      target.surplusResolutionReason = dto.reason;
      target.resolvedAt = now;
      target.resolvedBy = actor.id;
      await items.save(target);
      await this.signerHead.sync(manager, inventory, actor);
      await this.auditLogs.record(
        {
          action: AuditAction.InventorySurplusResolved,
          entityType: 'INVENTORY',
          entityId: inventory.id,
          performedBy: actor.id,
          ipAddress: null,
          userAgent: null,
          changes: {
            itemId: target.id,
            resolution: { from: previous, to: dto.action },
            resolvedAssetId: target.resolvedAssetId ?? null,
            surplusCostCenterId: target.surplusCostCenterId ?? null,
          },
        },
        manager,
      );
      return target;
    });
    return toItemView(item, await this.valuation.viewContext(inventory, [item]));
  }

  async setCenter(inventoryId: string, itemId: string, costCenterId: string, actor: AuthenticatedUser) {
    const inventory = await this.dataSource.getRepository(PhysicalInventory).findOne({ where: { id: inventoryId } });
    if (!inventory) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    if (inventory.status !== InventoryStatus.Closed) {
      throw new ApiException(
        ErrorCode.InvalidState,
        'El centro de un sobrante se elige con la toma cerrada y antes de aprobar la conciliación',
      );
    }
    if (inventory.scopeType === InventoryScopeType.CostCenter) {
      throw new ApiException(
        ErrorCode.InvalidState,
        'En una toma por centro de costo los sobrantes ya son del centro de la toma y van a su acta',
      );
    }
    await this.actorPolicy.assertCanOperate(inventory, actor);
    await this.assertCenterAcceptsAssets(costCenterId);
    const item = await this.dataSource.transaction(async (manager) => {
      const items = manager.getRepository(PhysicalInventoryItem);
      const found = await items.findOne({
        where: { id: itemId, inventoryId: inventory.id },
        lock: { mode: 'pessimistic_write' },
      });
      const [current] = (await manager.query('SELECT status FROM physical_inventory WHERE id = $1 FOR SHARE', [
        inventory.id,
      ])) as Array<{ status: InventoryStatus }>;
      if (current?.status !== InventoryStatus.Closed) {
        throw new ApiException(ErrorCode.InvalidState);
      }
      this.assertResolvable(found);
      const target = found as PhysicalInventoryItem;
      const previous = target.surplusCostCenterId ?? null;
      target.surplusCostCenterId = costCenterId;
      await items.save(target);
      await this.signerHead.sync(manager, inventory, actor);
      await this.auditLogs.record(
        {
          action: AuditAction.InventorySurplusCenterSet,
          entityType: 'INVENTORY',
          entityId: inventory.id,
          performedBy: actor.id,
          ipAddress: null,
          userAgent: null,
          changes: { itemId: target.id, surplusCostCenterId: { from: previous, to: costCenterId } },
        },
        manager,
      );
      return target;
    });
    return toItemView(item, await this.valuation.viewContext(inventory, [item]));
  }

  private async assertCenterAcceptsAssets(costCenterId: string): Promise<void> {
    const [center] = (await this.dataSource.query(
      'SELECT id FROM cost_center WHERE id = $1 AND is_active AND accepts_assets',
      [costCenterId],
    )) as Array<{ id: string }>;
    if (!center) {
      throw new ApiException(ErrorCode.ValidationFailed, 'El centro de costo no existe, está inactivo o no admite activos', [
        { field: 'costCenterId', message: 'Debe ser un centro de costo activo que admita activos' },
      ]);
    }
  }

  private assertResolvable(item: PhysicalInventoryItem | null): void {
    if (!item || item.verificationResult !== VerificationResult.Surplus || item.voidedAt) {
      throw new ApiException(ErrorCode.InventorySurplusNotResolvable, 'El ítem no es un sobrante vigente de esta toma');
    }
    if (item.wasLost) {
      throw new ApiException(ErrorCode.InventorySurplusWasLost);
    }
    if (item.assetId) {
      throw new ApiException(
        ErrorCode.InventorySurplusNotResolvable,
        'El sobrante es un activo ya registrado: no se crea otro',
      );
    }
    if (item.surplusResolution === 'CREATE_ASSET') {
      throw new ApiException(ErrorCode.InventorySurplusNotResolvable, 'El sobrante ya se registró como activo');
    }
  }

  private costCenterFor(inventory: PhysicalInventory, requested: string | undefined, action: ResolveSurplusDto['action']): string {
    if (inventory.scopeType === InventoryScopeType.CostCenter && inventory.scopeId) {
      if (requested && requested !== inventory.scopeId) {
        throw new ApiException(ErrorCode.ValidationFailed, undefined, [
          { field: 'costCenterId', message: 'En una toma por centro de costo el activo queda en el centro de la toma' },
        ]);
      }
      return inventory.scopeId;
    }
    if (!requested) {
      throw new ApiException(ErrorCode.ValidationFailed, undefined, [
        {
          field: 'costCenterId',
          message:
            action === 'CREATE_ASSET'
              ? 'La toma no es de un centro de costo: indique el centro del activo'
              : 'La toma no es de un centro de costo: indique el centro cuya acta lista el sobrante sin resolver',
        },
      ]);
    }
    return requested;
  }
}
