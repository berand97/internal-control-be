import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import { Location } from '../../locations/entities/location.entity.js';
import type {
  CorrectInventoryItemDto,
  SetFindingCategoryDto,
  VoidInventoryItemDto,
} from '../dto/inventory.dto.js';
import {
  InventoryItemCorrection,
  type InventoryCorrectionKind,
} from '../entities/inventory-item-correction.entity.js';
import { PhysicalInventory } from '../entities/physical-inventory.entity.js';
import { PhysicalInventoryItem } from '../entities/physical-inventory-item.entity.js';
import { InventoryStatus } from '../enums/inventory-status.js';
import { VerificationResult } from '../enums/verification-result.js';
import { InventoryActorPolicy } from './inventory-actor-policy.service.js';
import { InventoryCatalogsService } from './inventory-catalogs.service.js';
import { toItemView } from './inventory-item-view.js';

const ENTITY_TYPE = 'INVENTORY';

/** Lo que una corrección guarda del ítem antes y después (sin notas). */
const snapshot = (item: PhysicalInventoryItem) => ({
  result: item.verificationResult,
  actualCondition: item.actualCondition,
  actualLocationId: item.actualLocationId,
  missingCauseId: item.missingCauseId ?? null,
  missingCauseOther: item.missingCauseOther ?? null,
  findingCategory: item.findingCategoryCode ?? null,
  verifiedAt: item.verifiedAt ? new Date(item.verifiedAt).toISOString() : null,
  verifiedBy: item.verifiedBy,
  voided: !!item.voidedAt,
});

const invalid = (field: string, message: string): ApiException =>
  new ApiException(ErrorCode.ValidationFailed, undefined, [{ field, message }]);

/**
 * Correcciones con evidencia sobre una toma EN CURSO: cambiar el resultado de un ítem esperado, anular un sobrante
 * registrado por error y fijar la categoría de hallazgo. Cada corrección o anulación deja fila en
 * inventory_item_correction (antes, después, motivo, quién y cuándo) en la misma transacción que el ítem y la
 * auditoría; la auditoría guarda solo ids y resultados, nunca el motivo ni textos libres.
 */
@Injectable()
export class InventoryCorrectionsService {
  constructor(
    @InjectRepository(PhysicalInventory)
    private readonly inventories: Repository<PhysicalInventory>,
    @InjectRepository(PhysicalInventoryItem)
    private readonly items: Repository<PhysicalInventoryItem>,
    @InjectRepository(InventoryItemCorrection)
    private readonly corrections: Repository<InventoryItemCorrection>,
    @InjectRepository(Location)
    private readonly locations: Repository<Location>,
    private readonly dataSource: DataSource,
    private readonly actorPolicy: InventoryActorPolicy,
    private readonly catalogs: InventoryCatalogsService,
    @Inject('AuditLogsRepository')
    private readonly auditLogs: AuditLogsRepository,
  ) {}

  async correct(id: string, itemId: string, dto: CorrectInventoryItemDto, actor: AuthenticatedUser) {
    const inventory = await this.requireInProgress(id);
    await this.actorPolicy.assertCanOperate(inventory, actor);
    const item = await this.requireItem(inventory.id, itemId);
    if (item.verificationResult === VerificationResult.Surplus) {
      throw new ApiException(ErrorCode.InvalidState, 'Un sobrante no se corrige: se anula y, si aplica, se registra de nuevo');
    }
    const before = snapshot(item);
    await this.applyResult(item, dto, actor);
    if (dto.result === VerificationResult.Pending || dto.findingCategory === null) {
      item.findingCategoryCode = null;
    } else if (typeof dto.findingCategory === 'string') {
      item.findingCategoryCode = (await this.catalogs.requireAssignableCategory(dto.findingCategory)).code;
    }
    const after = snapshot(item);
    const comparable = (value: ReturnType<typeof snapshot>) => JSON.stringify({ ...value, verifiedAt: null, verifiedBy: null });
    if (comparable(before) === comparable(after)) {
      throw invalid('result', 'La corrección no cambia nada del ítem');
    }
    const correction = await this.persist(inventory, item, 'CORRECT', before, after, dto.reason, actor);
    return { item: toItemView(item, await this.catalogs.viewContext()), correction: this.toCorrection(correction) };
  }

  async voidSurplus(id: string, itemId: string, dto: VoidInventoryItemDto, actor: AuthenticatedUser) {
    const inventory = await this.requireInProgress(id);
    await this.actorPolicy.assertCanOperate(inventory, actor);
    const item = await this.requireItem(inventory.id, itemId);
    if (item.verificationResult !== VerificationResult.Surplus || item.voidedAt) {
      throw new ApiException(ErrorCode.InvalidState, 'Solo se anula un sobrante vigente');
    }
    const before = snapshot(item);
    item.voidedAt = new Date();
    item.findingCategoryCode = null;
    const after = snapshot(item);
    const correction = await this.persist(inventory, item, 'VOID', before, after, dto.reason, actor);
    return { item: toItemView(item, await this.catalogs.viewContext()), correction: this.toCorrection(correction) };
  }

  async setFindingCategory(id: string, itemId: string, dto: SetFindingCategoryDto, actor: AuthenticatedUser) {
    const inventory = await this.requireInProgress(id);
    await this.actorPolicy.assertCanOperate(inventory, actor);
    const item = await this.requireItem(inventory.id, itemId);
    if (item.voidedAt || item.verificationResult === VerificationResult.Pending) {
      throw new ApiException(ErrorCode.InvalidState, 'Solo se categoriza un ítem ya verificado y vigente');
    }
    const from = item.findingCategoryCode ?? null;
    const code = dto.code ? (await this.catalogs.requireAssignableCategory(dto.code)).code : null;
    item.findingCategoryCode = code;
    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(PhysicalInventoryItem).save(item);
      await this.auditLogs.record(
        {
          action: AuditAction.InventoryFindingSet,
          entityType: ENTITY_TYPE,
          entityId: inventory.id,
          performedBy: actor.id,
          ipAddress: null,
          userAgent: null,
          changes: { itemId: item.id, assetId: item.assetId, from, to: code },
        },
        manager,
      );
    });
    return toItemView(item, await this.catalogs.viewContext());
  }

  async listCorrections(id: string, itemId: string) {
    const inventory = await this.requireInventory(id);
    const item = await this.requireItem(inventory.id, itemId);
    const rows = await this.corrections.find({ where: { itemId: item.id }, order: { correctedAt: 'ASC' } });
    return rows.map((row) => this.toCorrection(row));
  }

  private async applyResult(item: PhysicalInventoryItem, dto: CorrectInventoryItemDto, actor: AuthenticatedUser) {
    const result = dto.result;
    const wantsCause = dto.causeId !== undefined || dto.otherCause !== undefined;
    if (result !== VerificationResult.Missing && wantsCause) {
      throw invalid('causeId', 'La causa solo aplica a MISSING');
    }
    if (result === VerificationResult.Pending) {
      if (dto.actualCondition !== undefined || dto.actualLocationId !== undefined) {
        throw invalid('result', 'PENDING no lleva condición ni ubicación observadas');
      }
      Object.assign(item, {
        verificationResult: VerificationResult.Pending,
        actualCondition: null,
        actualLocationId: null,
        missingCauseId: null,
        missingCauseOther: null,
        verifiedAt: null,
        verifiedBy: null,
      });
      return;
    }
    if (result === VerificationResult.Missing) {
      if (dto.actualCondition !== undefined || dto.actualLocationId !== undefined) {
        throw invalid('result', 'MISSING no lleva condición ni ubicación observadas');
      }
      const cause = await this.catalogs.resolveMissingCause(dto.causeId, dto.otherCause);
      Object.assign(item, {
        verificationResult: VerificationResult.Missing,
        actualCondition: null,
        actualLocationId: null,
        ...cause,
        verifiedAt: new Date(),
        verifiedBy: actor.id,
      });
      return;
    }
    if (!dto.actualCondition) {
      throw invalid('actualCondition', 'FOUND y MISPLACED exigen la condición observada');
    }
    if (dto.actualLocationId) {
      const location = await this.locations.findOne({ where: { id: dto.actualLocationId, isActive: true } });
      if (!location) {
        throw new ApiException(ErrorCode.ResourceNotFound);
      }
    }
    const expected = item.expectedLocationId;
    let actualLocationId: string | null;
    if (result === VerificationResult.Found) {
      actualLocationId = dto.actualLocationId ?? expected;
      if (expected !== null && actualLocationId !== expected) {
        throw invalid('actualLocationId', 'Con otra ubicación el resultado es MISPLACED');
      }
    } else {
      if (!dto.actualLocationId || expected === null || dto.actualLocationId === expected) {
        throw invalid('actualLocationId', 'MISPLACED exige una ubicación observada distinta de la esperada');
      }
      actualLocationId = dto.actualLocationId;
    }
    Object.assign(item, {
      verificationResult: result,
      actualCondition: dto.actualCondition,
      actualLocationId,
      missingCauseId: null,
      missingCauseOther: null,
      verifiedAt: new Date(),
      verifiedBy: actor.id,
    });
  }

  private async persist(
    inventory: PhysicalInventory,
    item: PhysicalInventoryItem,
    kind: InventoryCorrectionKind,
    before: ReturnType<typeof snapshot>,
    after: ReturnType<typeof snapshot>,
    reason: string,
    actor: AuthenticatedUser,
  ): Promise<InventoryItemCorrection> {
    return this.dataSource.transaction(async (manager) => {
      await manager.getRepository(PhysicalInventoryItem).save(item);
      const correction = await manager.getRepository(InventoryItemCorrection).save(
        manager.getRepository(InventoryItemCorrection).create({
          itemId: item.id,
          inventoryId: inventory.id,
          kind,
          before,
          after,
          reason: reason.trim(),
          correctedBy: actor.id,
          correctedAt: new Date(),
        }),
      );
      await this.auditLogs.record(
        {
          action: kind === 'VOID' ? AuditAction.InventoryItemVoided : AuditAction.InventoryItemCorrected,
          entityType: ENTITY_TYPE,
          entityId: inventory.id,
          performedBy: actor.id,
          ipAddress: null,
          userAgent: null,
          changes: {
            correctionId: correction.id,
            itemId: item.id,
            assetId: item.assetId,
            from: before.result,
            to: after.result,
            voided: after.voided,
          },
        },
        manager,
      );
      return correction;
    });
  }

  private toCorrection(row: InventoryItemCorrection) {
    return {
      id: row.id,
      itemId: row.itemId,
      inventoryId: row.inventoryId,
      kind: row.kind,
      before: row.before,
      after: row.after,
      reason: row.reason,
      correctedBy: row.correctedBy,
      correctedAt: row.correctedAt,
    };
  }

  private async requireInventory(id: string): Promise<PhysicalInventory> {
    const inventory = await this.inventories.findOne({ where: { id } });
    if (!inventory) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return inventory;
  }

  private async requireInProgress(id: string): Promise<PhysicalInventory> {
    const inventory = await this.requireInventory(id);
    if (inventory.status !== InventoryStatus.InProgress) {
      throw new ApiException(ErrorCode.InvalidState, 'La toma no está en curso');
    }
    return inventory;
  }

  private async requireItem(inventoryId: string, itemId: string): Promise<PhysicalInventoryItem> {
    const item = await this.items.findOne({ where: { id: itemId, inventoryId } });
    if (!item) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return item;
  }
}
