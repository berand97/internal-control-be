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

/** Registrar un activo nuevo exige el mismo permiso que el alta normal. */
const ASSET_CREATE_PERMISSION = 'asset:create:global';

/**
 * Qué hacer con un sobrante sin activo registrado, con la toma CLOSED y antes de aprobar la conciliación (la
 * aprobación es de otra persona y ve lo decidido). CREATE_ASSET registra el activo (mismo camino que el alta normal,
 * con movimiento REGISTRATION que cita la toma) y lo enlaza al ítem, todo en una transacción; LEAVE_UNRESOLVED deja
 * constancia del motivo y se puede cambiar después por CREATE_ASSET. Un sobrante de un activo LOST no pasa por aquí.
 */
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
    const costCenterId = dto.action === 'CREATE_ASSET' ? this.costCenterFor(inventory, dto.costCenterId) : null;

    const item = await this.dataSource.transaction(async (manager) => {
      const items = manager.getRepository(PhysicalInventoryItem);
      const found = await items.findOne({
        where: { id: itemId, inventoryId: inventory.id },
        lock: { mode: 'pessimistic_write' },
      });
      // La toma no debe haberse conciliado entre la lectura y el bloqueo del ítem.
      const [current] = (await manager.query('SELECT status FROM physical_inventory WHERE id = $1 FOR SHARE', [
        inventory.id,
      ])) as Array<{ status: InventoryStatus }>;
      if (current?.status !== InventoryStatus.Closed) {
        throw new ApiException(ErrorCode.InvalidState);
      }
      this.assertResolvable(found);
      const target = found as PhysicalInventoryItem;
      const now = new Date();
      if (dto.action === 'CREATE_ASSET' && dto.asset && costCenterId) {
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
      // El activo creado puede ser de un centro sin acta en la toma: recibe la suya (con su único jefe, si lo tiene).
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
          },
        },
        manager,
      );
      return target;
    });
    return toItemView(item, await this.valuation.viewContext(inventory, [item]));
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

  /** Alcance COST_CENTER: el centro de la toma. Otro alcance: el que venga en el cuerpo (obligatorio). */
  private costCenterFor(inventory: PhysicalInventory, requested: string | undefined): string {
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
        { field: 'costCenterId', message: 'La toma no es de un centro de costo: indique el centro del activo' },
      ]);
    }
    return requested;
  }
}
