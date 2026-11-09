import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { Asset } from '../../assets/entities/asset.entity.js';
import { AssetStateService } from '../../assets/services/asset-state.service.js';
import { MovementType } from '../../assets/enums/movement-type.enum.js';
import { OperationalStatus } from '../../assets/enums/operational-status.enum.js';
import { PhysicalInventory } from '../entities/physical-inventory.entity.js';
import { PhysicalInventoryItem } from '../entities/physical-inventory-item.entity.js';
import { VerificationResult } from '../enums/verification-result.js';

@Injectable()
export class InventoryAssetEffectsService {
  constructor(private readonly assetState: AssetStateService) {}

  async applyVerificationFindings(
    inventory: PhysicalInventory,
    item: PhysicalInventoryItem,
    actor: AuthenticatedUser,
    manager: EntityManager,
  ): Promise<void> {
    if (!item.assetId) {
      return;
    }
    if (item.verificationResult === VerificationResult.Misplaced) {
      await this.applyLocation(inventory, item, actor, manager);
    }
    if (item.verificationResult === VerificationResult.Missing) {
      await this.applyLost(inventory, item, actor, manager);
      return;
    }
    if (
      (item.verificationResult === VerificationResult.Found ||
        item.verificationResult === VerificationResult.Misplaced) &&
      item.actualCondition &&
      item.expectedCondition &&
      item.actualCondition !== item.expectedCondition
    ) {
      await this.applyCondition(inventory, item, actor, manager);
    }
  }

  async applyCorrectionEffects(
    inventory: PhysicalInventory,
    before: VerificationResult,
    item: PhysicalInventoryItem,
    actor: AuthenticatedUser,
    manager: EntityManager,
  ): Promise<void> {
    if (!item.assetId) {
      return;
    }
    if (before === VerificationResult.Missing && item.verificationResult !== VerificationResult.Missing) {
      await this.restoreFromLost(inventory, item, actor, manager);
    }
    await this.applyVerificationFindings(inventory, item, actor, manager);
  }

  async applyLocation(
    inventory: PhysicalInventory,
    item: PhysicalInventoryItem,
    actor: AuthenticatedUser,
    manager: EntityManager,
  ): Promise<void> {
    if (!item.assetId || !item.actualLocationId) {
      return;
    }
    const asset = await this.requireAsset(item.assetId, manager);
    if (asset.locationId === item.actualLocationId) {
      return;
    }
    await this.assetState.apply(
      {
        assetId: asset.id,
        actorId: actor.id,
        patch: { locationId: item.actualLocationId },
        movement: {
          type: MovementType.Relocation,
          reason: `Toma física ${inventory.code}`,
          documentReference: inventory.code,
          metadata: { inventoryId: inventory.id },
        },
      },
      manager,
    );
  }

  async applyLost(
    inventory: PhysicalInventory,
    item: PhysicalInventoryItem,
    actor: AuthenticatedUser,
    manager: EntityManager,
  ): Promise<void> {
    if (!item.assetId) {
      return;
    }
    const asset = await this.requireAsset(item.assetId, manager);
    if (
      asset.operationalStatus === OperationalStatus.Lost ||
      asset.operationalStatus === OperationalStatus.WrittenOff
    ) {
      return;
    }
    await this.assetState.apply(
      {
        assetId: asset.id,
        actorId: actor.id,
        patch: { operationalStatus: OperationalStatus.Lost },
        movement: {
          type: MovementType.PhysicalVerification,
          reason: `Faltante en ${inventory.code}. Inicia la baja formal.`,
          documentReference: inventory.code,
          metadata: { inventoryId: inventory.id, result: 'MISSING' },
        },
      },
      manager,
    );
  }

  async applyCondition(
    inventory: PhysicalInventory,
    item: PhysicalInventoryItem,
    actor: AuthenticatedUser,
    manager: EntityManager,
  ): Promise<void> {
    if (!item.assetId || !item.actualCondition) {
      return;
    }
    const asset = await this.requireAsset(item.assetId, manager);
    if (asset.physicalCondition === item.actualCondition) {
      return;
    }
    await this.assetState.apply(
      {
        assetId: item.assetId,
        actorId: actor.id,
        patch: { physicalCondition: item.actualCondition },
        movement: {
          type: MovementType.ConditionChange,
          reason: `Toma física ${inventory.code}`,
          documentReference: inventory.code,
          metadata: { inventoryId: inventory.id },
        },
      },
      manager,
    );
  }

  private async restoreFromLost(
    inventory: PhysicalInventory,
    item: PhysicalInventoryItem,
    actor: AuthenticatedUser,
    manager: EntityManager,
  ): Promise<void> {
    if (!item.assetId) {
      return;
    }
    const asset = await this.requireAsset(item.assetId, manager);
    if (asset.operationalStatus !== OperationalStatus.Lost) {
      return;
    }
    await this.assetState.apply(
      {
        assetId: asset.id,
        actorId: actor.id,
        patch: { operationalStatus: OperationalStatus.InUse },
        movement: {
          type: MovementType.PhysicalVerification,
          reason: `Corrección en ${inventory.code}: el activo ya no figura como faltante`,
          documentReference: inventory.code,
          metadata: { inventoryId: inventory.id, result: item.verificationResult },
        },
      },
      manager,
    );
  }

  private async requireAsset(id: string, manager: EntityManager): Promise<Asset> {
    const asset = await manager.getRepository(Asset).findOne({ where: { id } });
    if (!asset) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return asset;
  }
}
