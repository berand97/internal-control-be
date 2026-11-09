import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, type EntityManager, Repository } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { AppUser } from '../../auth/entities/app-user.entity.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import { Asset } from '../../assets/entities/asset.entity.js';
import { AssetStateService } from '../../assets/services/asset-state.service.js';
import { MovementType } from '../../assets/enums/movement-type.enum.js';
import { OperationalStatus } from '../../assets/enums/operational-status.enum.js';
import { PhysicalCondition } from '../../assets/enums/physical-condition.enum.js';
import { CostCenter } from '../../cost-centers/entities/cost-center.entity.js';
import { Location } from '../../locations/entities/location.entity.js';
import { OrganizationalUnit } from '../../organizational-units/entities/organizational-unit.entity.js';
import { PermissionsService } from '../../roles/services/permissions.service.js';
import {
  assertInventoryTransition,
  exceedsUnverifiedThreshold,
} from '../domain/inventory-transitions.js';
import { scopeSql } from '../domain/inventory-scope-sql.js';
import {
  CloseInventoryDto,
  QueryInventoriesDto,
  ReportNotFoundDto,
  ReportUnexpectedDto,
  VerifyInventoryAssetDto,
} from '../dto/inventory.dto.js';
import { PhysicalInventory } from '../entities/physical-inventory.entity.js';
import { PhysicalInventoryItem } from '../entities/physical-inventory-item.entity.js';
import { PhysicalInventoryScope } from '../entities/physical-inventory-scope.entity.js';
import { InventoryScopeType } from '../enums/inventory-scope.js';
import { InventoryStatus } from '../enums/inventory-status.js';
import { VerificationResult } from '../enums/verification-result.js';
import { InventoryActorPolicy } from './inventory-actor-policy.service.js';
import { InventoryCatalogsService } from './inventory-catalogs.service.js';
import { InventoryActService } from './inventory-act.service.js';
import { type ItemViewContext, mergeFrozenReport, toItemView, toProgressView, toReportView } from './inventory-item-view.js';
import { ControlSignersService } from '../../documents/services/control-signers.service.js';
import { FeatureFlagsService } from '../../features/services/feature-flags.service.js';
import { InventoryAssetEffectsService } from './inventory-asset-effects.service.js';
import { InventorySignerHeadService } from './inventory-signer-head.service.js';
import { InventoryValuationService } from './inventory-valuation.service.js';
import { inventorySummary, inventorySummaryUserIds, loadResponsibleNames } from './inventory-summary.js';
import { localeIsoDate } from '../../../shared/dates/locale-iso-date.js';

export const INVENTORY_ACT_ACCOUNTING_FLAG = 'inventory-act-accounting';
const ACCOUNTING_SIGN_PERMISSION = 'transfer:sign_accounting:global';

const ENTITY_TYPE = 'INVENTORY';

const TEMPORARY_CODE_FLAG = 'BARCODE_TEMP';

interface ScopeAssetRow {
  readonly id: string;
  readonly current_location_id: string | null;
  readonly physical_condition: PhysicalCondition;
  readonly current_cost_center_id: string;
  readonly operational_status: OperationalStatus;
  readonly code_temporary: boolean;
}

@Injectable()
export class InventoriesService {
  constructor(
    @InjectRepository(PhysicalInventory)
    private readonly inventories: Repository<PhysicalInventory>,
    @InjectRepository(PhysicalInventoryItem)
    private readonly items: Repository<PhysicalInventoryItem>,
    @InjectRepository(PhysicalInventoryScope)
    private readonly scopes: Repository<PhysicalInventoryScope>,
    @InjectRepository(Asset)
    private readonly assets: Repository<Asset>,
    @InjectRepository(AppUser)
    private readonly users: Repository<AppUser>,
    @InjectRepository(CostCenter)
    private readonly costCenters: Repository<CostCenter>,
    @InjectRepository(Location)
    private readonly locations: Repository<Location>,
    @InjectRepository(OrganizationalUnit)
    private readonly orgUnits: Repository<OrganizationalUnit>,
    private readonly dataSource: DataSource,
    private readonly permissionsService: PermissionsService,
    @Inject('AuditLogsRepository')
    private readonly auditLogsRepository: AuditLogsRepository,
    private readonly assetState: AssetStateService,
    private readonly actorPolicy: InventoryActorPolicy,
    private readonly catalogs: InventoryCatalogsService,
    private readonly valuation: InventoryValuationService,
    private readonly act: InventoryActService,
    private readonly signerHead: InventorySignerHeadService,
    private readonly assetEffects: InventoryAssetEffectsService,
    private readonly featureFlags: FeatureFlagsService,
    private readonly controlSigners: ControlSignersService,
  ) {}

  accountingSigners() {
    return this.controlSigners.holders(ACCOUNTING_SIGN_PERMISSION);
  }

  requiresAccountingSigner(): boolean {
    return this.featureFlags.isEnabled(INVENTORY_ACT_ACCOUNTING_FLAG);
  }

  private async resolveAccountingSigner(chosen?: string): Promise<string | null> {
    if (!this.requiresAccountingSigner()) {
      return null;
    }
    const holders = await this.accountingSigners();
    if (holders.length === 0) {
      throw new ApiException(
        ErrorCode.ValidationFailed,
        'No hay firmante de Contabilidad. Active el rol Contabilidad o desactive el parámetro del acta.',
        [{ field: 'accountingSignerPersonId', message: 'No hay personas elegibles de Contabilidad.' }],
      );
    }
    if (holders.length === 1) {
      const only = holders[0]?.personId ?? null;
      if (chosen && chosen !== only) {
        throw new ApiException(ErrorCode.ValidationFailed, 'Esa persona no firma por Contabilidad.', [
          { field: 'accountingSignerPersonId', message: 'Elija al firmante elegible de Contabilidad.' },
        ]);
      }
      return only;
    }
    if (!chosen) {
      throw new ApiException(ErrorCode.ValidationFailed, 'Elija quién firma por Contabilidad.', [
        { field: 'accountingSignerPersonId', message: 'Obligatorio cuando Contabilidad firma el acta.' },
      ]);
    }
    if (!holders.some((holder) => holder.personId === chosen)) {
      throw new ApiException(ErrorCode.ValidationFailed, 'Esa persona no firma por Contabilidad.', [
        { field: 'accountingSignerPersonId', message: 'Elija un firmante elegible de Contabilidad.' },
      ]);
    }
    return chosen;
  }

  async list(query: QueryInventoriesDto) {
    const page = Number(query.page) || 1;
    const pageSize = Math.min(Number(query.pageSize) || 20, 100);
    const qb = this.inventories.createQueryBuilder('i');
    if (query.status) {
      qb.andWhere('i.status = :status', { status: query.status });
    }
    if (query.scope) {
      qb.andWhere('i.scope_type = :scope', { scope: query.scope });
    }
    const total = await qb.getCount();
    const rows = await qb
      .orderBy('i.created_at', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getMany();
    const names = await loadResponsibleNames(
      this.dataSource,
      rows.flatMap(inventorySummaryUserIds),
    );
    return {
      items: rows.map((row) => inventorySummary(row, names)),
      total,
      page,
      pageSize,
      hasNext: page * pageSize < total,
    };
  }

  async getById(id: string) {
    const inventory = await this.requireInventory(id);
    const items = await this.items.find({
      where: { inventoryId: id },
      order: { verificationResult: 'ASC' },
    });
    const context = await this.valuation.viewContext(inventory, items);
    const names = await loadResponsibleNames(this.dataSource, inventorySummaryUserIds(inventory));
    return {
      ...inventorySummary(inventory, names),
      items: items.map((item) => toItemView(item, context)),
      progress: toProgressView(items),
      report: this.frozenOrLiveReport(inventory, items, context),
      reconciliationBasis: await this.valuation.basis(inventory),
      fieldCloseEvidence:
        inventory.fieldCloseSignatureSha256 && inventory.fieldCloseSignedAt && inventory.fieldCloseCapturedBy
          ? {
              sha256: inventory.fieldCloseSignatureSha256,
              signedAt: inventory.fieldCloseSignedAt,
              capturedBy: inventory.fieldCloseCapturedBy,
              capturedByName: names.get(inventory.fieldCloseCapturedBy) ?? null,
              signaturePng: inventory.fieldCloseSignaturePng,
            }
          : null,
      ...(await this.act.detail(inventory)),
    };
  }

  async start(id: string, actor: AuthenticatedUser) {
    const inventory = await this.requireInventory(id);
    assertInventoryTransition(inventory.status, InventoryStatus.InProgress);
    await this.actorPolicy.assertCanOperate(inventory, actor);
    await this.assertNoRunningOverlap(
      inventory.scopeType,
      inventory.scopeId,
      inventory.id,
    );
    const assets = await this.findAssetsInScope(
      inventory.scopeType,
      inventory.scopeId,
    );
    const now = new Date();
    const rows = assets.map((asset) =>
      this.items.create({
        inventoryId: inventory.id,
        assetId: asset.id,
        verificationResult: VerificationResult.Pending,
        expectedLocationId: asset.current_location_id,
        actualLocationId: null,
        expectedCondition: asset.physical_condition,
        actualCondition: null,
        expectedCostCenterId: asset.current_cost_center_id,
        expectedCodeTemporary: asset.code_temporary === true,
        wasLost: false,
        voidedAt: null,
        findingCategoryCode: null,
        missingCauseId: null,
        missingCauseOther: null,
        isOnLoan: asset.operational_status === OperationalStatus.OnLoan,
        verifiedAt: null,
        verifiedBy: null,
        notes: asset.operational_status === OperationalStatus.OnLoan
          ? 'En préstamo — verificación remota permitida'
          : null,
        photoUrl: null,
      }),
    );
    await this.dataSource.transaction(async (manager) => {
      const itemRepository = manager.getRepository(PhysicalInventoryItem);
      for (let index = 0; index < rows.length; index += 500) {
        await itemRepository.save(rows.slice(index, index + 500));
      }
      inventory.status = InventoryStatus.InProgress;
      inventory.actualStartDate = localeIsoDate(now);
      inventory.snapshotTakenAt = now;
      await manager.getRepository(PhysicalInventory).save(inventory);
      await this.auditLogsRepository.record(
        {
          action: AuditAction.InventoryStarted,
          entityType: ENTITY_TYPE,
          entityId: inventory.id,
          performedBy: actor.id,
          ipAddress: null,
          userAgent: null,
          changes: {
            expectedAssets: assets.length,
            temporaryCode: assets.filter((asset) => asset.code_temporary === true).length,
          },
        },
        manager,
      );
    });
    return this.getById(inventory.id);
  }

  async verifyAsset(
    id: string,
    dto: VerifyInventoryAssetDto,
    actor: AuthenticatedUser,
  ) {
    const inventory = await this.requireInProgress(id);
    await this.actorPolicy.assertCanOperate(inventory, actor);
    const item = await this.items.findOne({
      where: {
        inventoryId: inventory.id,
        assetId: dto.assetId,
      },
    });
    if (!item || item.verificationResult === VerificationResult.Surplus) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    if (item.verificationResult !== VerificationResult.Pending) {
      throw new ApiException(ErrorCode.InvalidState);
    }
    const asset = await this.requireAsset(dto.assetId);
    if (dto.locationId) {
      const location = await this.locations.findOne({
        where: { id: dto.locationId, isActive: true },
      });
      if (!location) {
        throw new ApiException(ErrorCode.ResourceNotFound);
      }
    }
    const actualLocationId = dto.locationId ?? item.expectedLocationId;
    const misplaced =
      actualLocationId !== null &&
      item.expectedLocationId !== null &&
      actualLocationId !== item.expectedLocationId;
    item.verificationResult = misplaced
      ? VerificationResult.Misplaced
      : VerificationResult.Found;
    item.actualLocationId = actualLocationId;
    item.actualCondition = dto.condition;
    item.notes = dto.notes ?? item.notes;
    item.verifiedAt = new Date();
    item.verifiedBy = actor.id;
    await this.dataSource.transaction(async (manager) => {
      await this.assetState.apply(
        {
          assetId: asset.id,
          actorId: actor.id,
          patch: { lastVerifiedAt: item.verifiedAt },
          movement: {
            type: MovementType.PhysicalVerification,
            reason: dto.notes ?? `Verificación ${inventory.code}`,
            documentReference: inventory.code,
            executedAt: item.verifiedAt as Date,
            metadata: {
              inventoryId: inventory.id,
              result: item.verificationResult,
              observedLocationId: actualLocationId,
              observedCondition: dto.condition,
            },
          },
          alsoWrite: async (writeManager) => {
            await writeManager.getRepository(PhysicalInventoryItem).save(item);
          },
        },
        manager,
      );
      await this.assetEffects.applyVerificationFindings(inventory, item, actor, manager);
    });
    return toItemView(item, await this.valuation.viewContext(inventory, [item]));
  }

  async reportNotFound(
    id: string,
    dto: ReportNotFoundDto,
    actor: AuthenticatedUser,
  ) {
    const inventory = await this.requireInProgress(id);
    await this.actorPolicy.assertCanOperate(inventory, actor);
    const item = await this.items.findOne({
      where: { inventoryId: inventory.id, assetId: dto.assetId },
    });
    if (!item || item.verificationResult === VerificationResult.Surplus) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    if (item.verificationResult !== VerificationResult.Pending) {
      throw new ApiException(ErrorCode.InvalidState);
    }
    const cause = await this.catalogs.resolveMissingCause(dto.causeId, dto.otherCause);
    item.verificationResult = VerificationResult.Missing;
    item.missingCauseId = cause.missingCauseId;
    item.missingCauseOther = cause.missingCauseOther;
    item.notes = dto.notes ?? item.notes;
    item.verifiedAt = new Date();
    item.verifiedBy = actor.id;
    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(PhysicalInventoryItem).save(item);
      await this.assetEffects.applyLost(inventory, item, actor, manager);
    });
    return toItemView(item, await this.valuation.viewContext(inventory, [item]));
  }

  async reportUnexpected(
    id: string,
    dto: ReportUnexpectedDto,
    actor: AuthenticatedUser,
  ) {
    const inventory = await this.requireInProgress(id);
    await this.actorPolicy.assertCanOperate(inventory, actor);
    let wasLost = false;
    if (dto.assetId) {
      const existing = await this.items.findOne({
        where: { inventoryId: inventory.id, assetId: dto.assetId },
      });
      if (existing && !existing.voidedAt) {
        throw new ApiException(ErrorCode.InvalidState);
      }
      const asset = await this.requireAsset(dto.assetId);
      if (asset.operationalStatus === OperationalStatus.WrittenOff) {
        throw new ApiException(ErrorCode.InventoryAssetWrittenOff);
      }
      wasLost = asset.operationalStatus === OperationalStatus.Lost;
    }
    const item = await this.items.save(
      this.items.create({
        inventoryId: inventory.id,
        assetId: dto.assetId ?? null,
        verificationResult: VerificationResult.Surplus,
        expectedLocationId: null,
        actualLocationId: dto.locationId ?? null,
        expectedCondition: null,
        actualCondition: dto.condition ?? null,
        expectedCostCenterId: null,
        expectedCodeTemporary: null,
        wasLost,
        voidedAt: null,
        findingCategoryCode: null,
        missingCauseId: null,
        missingCauseOther: null,
        isOnLoan: false,
        verifiedAt: new Date(),
        verifiedBy: actor.id,
        notes: dto.notes ?? null,
        photoUrl: null,
      }),
    );
    return toItemView(item, await this.valuation.viewContext(inventory, [item]));
  }

  async progress(id: string) {
    const inventory = await this.requireInventory(id);
    const items = await this.items.find({ where: { inventoryId: inventory.id } });
    return {
      inventoryId: inventory.id,
      status: inventory.status,
      ...toProgressView(items),
    };
  }

  async close(id: string, dto: CloseInventoryDto, actor: AuthenticatedUser) {
    const inventory = await this.requireInventory(id);
    assertInventoryTransition(inventory.status, InventoryStatus.Closed);
    await this.actorPolicy.assertCanOperate(inventory, actor);
    const before = toProgressView(await this.items.find({ where: { inventoryId: inventory.id } }));
    if (exceedsUnverifiedThreshold(before.pending, before.expected)) {
      if (dto.allowUnverified !== true) {
        throw new ApiException(ErrorCode.InventoryUnverifiedExceedsThreshold);
      }
      const canAuthorize = await this.permissionsService.userHasPermission(
        actor.id,
        'inventory:create:global',
      );
      if (!canAuthorize) {
        throw new ApiException(ErrorCode.InsufficientPermissions);
      }
    }
    const signature = dto.encargadoSignaturePng?.trim() ?? '';
    if (!/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(signature) || signature.length < 800) {
      throw new ApiException(ErrorCode.ValidationFailed, 'La firma del Encargado es obligatoria.', [
        { field: 'encargadoSignaturePng', message: 'Capture la firma manuscrita del Encargado.' },
      ]);
    }
    const accountingSignerPersonId = await this.resolveAccountingSigner(dto.accountingSignerPersonId);
    const signatureSha256 = createHash('sha256').update(signature).digest('hex');
    const context = await this.valuation.viewContext(inventory, []);
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `UPDATE physical_inventory_item SET verification_result = $2
         WHERE inventory_id = $1 AND verification_result = $3`,
        [inventory.id, VerificationResult.NotVerified, VerificationResult.Pending],
      );
      const items = await manager.getRepository(PhysicalInventoryItem).find({ where: { inventoryId: inventory.id } });
      const report = toReportView(items, context);
      const now = new Date();
      inventory.status = InventoryStatus.Closed;
      inventory.actualEndDate = localeIsoDate(now);
      inventory.closedAt = now;
      inventory.closedBy = actor.id;
      inventory.discrepancyReport = report;
      inventory.fieldCloseSignaturePng = signature;
      inventory.fieldCloseSignatureSha256 = signatureSha256;
      inventory.fieldCloseSignedAt = now;
      inventory.fieldCloseCapturedBy = actor.id;
      const acts = await this.signerHead.applyOnClose(manager, inventory, dto, actor);
      await this.signerHead.assertNoUnassignedSurplus(inventory, manager);
      for (const item of items) {
        await this.assetEffects.applyVerificationFindings(inventory, item, actor, manager);
      }
      await this.act.enqueueOnApproval(manager, inventory, actor, accountingSignerPersonId);
      assertInventoryTransition(InventoryStatus.Closed, InventoryStatus.Reconciled);
      inventory.status = InventoryStatus.Reconciled;
      inventory.reconcileRequestedAt = now;
      inventory.reconcileRequestedBy = actor.id;
      inventory.reconcileApprovedAt = now;
      inventory.reconcileApprovedBy = actor.id;
      await manager.getRepository(PhysicalInventory).save(inventory);
      await this.auditLogsRepository.record(
        {
          action: AuditAction.InventoryClosed,
          entityType: ENTITY_TYPE,
          entityId: inventory.id,
          performedBy: actor.id,
          ipAddress: null,
          userAgent: null,
          changes: {
            ...toProgressView(items),
            allowUnverified: dto.allowUnverified === true,
            fieldCloseSignatureSha256: signatureSha256,
            fieldCloseSignedAt: now.toISOString(),
            fieldCloseCapturedBy: actor.id,
            reconciledOnClose: true,
            acts: acts.map((act) => ({ costCenterId: act.costCenterId, signerHeadPersonId: act.signerHeadPersonId })),
          },
        },
        manager,
      );
      await this.auditLogsRepository.record(
        {
          action: AuditAction.InventoryReconciled,
          entityType: ENTITY_TYPE,
          entityId: inventory.id,
          performedBy: actor.id,
          ipAddress: null,
          userAgent: null,
          changes: {
            requestedBy: actor.id,
            approvedBy: actor.id,
            onClose: true,
          },
        },
        manager,
      );
    });
    return this.getById(inventory.id);
  }

  async report(id: string) {
    const inventory = await this.requireInventory(id);
    const items = await this.items.find({ where: { inventoryId: inventory.id } });
    return {
      inventoryId: inventory.id,
      code: inventory.code,
      status: inventory.status,
      ...this.frozenOrLiveReport(inventory, items, await this.valuation.viewContext(inventory, items)),
      reconciliationBasis: await this.valuation.basis(inventory),
    };
  }

  private frozenOrLiveReport(
    inventory: PhysicalInventory,
    items: ReadonlyArray<PhysicalInventoryItem>,
    context: ItemViewContext,
  ) {
    return inventory.discrepancyReport
      ? mergeFrozenReport(inventory.discrepancyReport, items, context)
      : toReportView(items, context);
  }

  async requestReconcile(id: string, _actor: AuthenticatedUser) {
    const inventory = await this.requireInventory(id);
    if (inventory.status === InventoryStatus.Reconciled) {
      throw new ApiException(
        ErrorCode.InvalidState,
        'La toma ya quedó reconciliada al cerrar. Use el acta en Documentos.',
      );
    }
    throw new ApiException(
      ErrorCode.InvalidState,
      'La reconciliación ocurre al cerrar la auditoría. No hace falta solicitarla.',
    );
  }

  async approveReconcile(id: string, actor: AuthenticatedUser) {
    const inventory = await this.requireInventory(id);
    if (inventory.status === InventoryStatus.Reconciled) {
      throw new ApiException(
        ErrorCode.InvalidState,
        'La toma ya quedó reconciliada al cerrar. Use el acta en Documentos.',
      );
    }
    if (inventory.status !== InventoryStatus.Closed || !inventory.reconcileRequestedBy) {
      throw new ApiException(
        ErrorCode.InvalidState,
        'La reconciliación ocurre al cerrar la auditoría.',
      );
    }
    if (inventory.reconcileRequestedBy === actor.id) {
      throw new ApiException(ErrorCode.InventoryReconcileSod);
    }
    const items = await this.items.find({ where: { inventoryId: inventory.id } });
    await this.dataSource.transaction(async (manager) => {
      await this.signerHead.assertNoUnassignedSurplus(inventory, manager);
      for (const item of items) {
        await this.assetEffects.applyVerificationFindings(inventory, item, actor, manager);
      }
      inventory.status = InventoryStatus.Reconciled;
      inventory.reconcileApprovedAt = new Date();
      inventory.reconcileApprovedBy = actor.id;
      await this.act.enqueueOnApproval(manager, inventory, actor);
      await manager.getRepository(PhysicalInventory).save(inventory);
      await this.auditLogsRepository.record(
        {
          action: AuditAction.InventoryReconciled,
          entityType: ENTITY_TYPE,
          entityId: inventory.id,
          performedBy: actor.id,
          ipAddress: null,
          userAgent: null,
          changes: {
            requestedBy: inventory.reconcileRequestedBy,
            approvedBy: actor.id,
            legacy: true,
          },
        },
        manager,
      );
    });
    return this.getById(inventory.id);
  }

  assertScope(
    scope: InventoryScopeType,
    scopeId: string | undefined,
  ): void {
    if (scope === InventoryScopeType.Global && scopeId) {
      throw new ApiException(ErrorCode.ValidationFailed);
    }
    if (scope !== InventoryScopeType.Global && !scopeId) {
      throw new ApiException(ErrorCode.ValidationFailed);
    }
  }

  async requireScopeTarget(
    scope: InventoryScopeType,
    scopeId: string | null,
  ): Promise<void> {
    if (scope === InventoryScopeType.Global || !scopeId) {
      return;
    }
    if (scope === InventoryScopeType.CostCenter) {
      const center = await this.costCenters.findOne({
        where: { id: scopeId, isActive: true },
      });
      if (!center) {
        throw new ApiException(ErrorCode.ResourceNotFound);
      }
      return;
    }
    if (scope === InventoryScopeType.Location) {
      const location = await this.locations.findOne({
        where: { id: scopeId, isActive: true },
      });
      if (!location) {
        throw new ApiException(ErrorCode.ResourceNotFound);
      }
      return;
    }
    const unit = await this.orgUnits.findOne({
      where: { id: scopeId, isActive: true },
    });
    if (!unit) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
  }

  private async assertNoRunningOverlap(
    scopeType: InventoryScopeType,
    scopeId: string | null,
    excludeId: string | null,
  ): Promise<void> {
    const others = await this.inventories.find({
      where: { status: InventoryStatus.InProgress },
    });
    for (const other of others) {
      if (excludeId && other.id === excludeId) {
        continue;
      }
      if (
        other.scopeType === InventoryScopeType.Global ||
        scopeType === InventoryScopeType.Global ||
        (other.scopeType === scopeType && other.scopeId === scopeId)
      ) {
        throw new ApiException(ErrorCode.InventoryScopeOverlap);
      }
      const overlap = await this.scopesShareAssets(
        { type: scopeType, id: scopeId },
        { type: other.scopeType, id: other.scopeId },
      );
      if (overlap) {
        throw new ApiException(ErrorCode.InventoryScopeOverlap);
      }
    }
  }

  private async scopesShareAssets(
    left: { readonly type: InventoryScopeType; readonly id: string | null },
    right: { readonly type: InventoryScopeType; readonly id: string | null },
  ): Promise<boolean> {
    const leftSql = scopeSql('a', left.type, left.id, 1);
    const rightSql = scopeSql(
      'a',
      right.type,
      right.id,
      1 + leftSql.params.length,
    );
    const rows: unknown = await this.dataSource.query(
      `
      SELECT EXISTS (
        SELECT 1 FROM asset a
        WHERE a.operational_status <> 'WRITTEN_OFF'
          AND (${leftSql.sql})
          AND (${rightSql.sql})
      ) AS overlap
      `,
      [...leftSql.params, ...rightSql.params],
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row || typeof row !== 'object') {
      return false;
    }
    const value = (row as { overlap?: unknown }).overlap;
    return value === true || value === 't' || value === 'true';
  }

  private async findAssetsInScope(
    scopeType: InventoryScopeType,
    scopeId: string | null,
  ): Promise<ReadonlyArray<ScopeAssetRow>> {
    const scoped = scopeSql('a', scopeType, scopeId, 1);
    const rows: unknown = await this.dataSource.query(
      `
      SELECT a.id, a.current_location_id, a.physical_condition,
             a.current_cost_center_id, a.operational_status,
             ($${scoped.params.length + 1} = ANY(a.data_quality_flags)) AS code_temporary
      FROM asset a
      WHERE a.operational_status <> 'WRITTEN_OFF'
        AND (${scoped.sql})
      `,
      [...scoped.params, TEMPORARY_CODE_FLAG],
    );
    if (!Array.isArray(rows)) {
      return [];
    }
    return rows as ScopeAssetRow[];
  }

  async nextCode(manager?: EntityManager): Promise<string> {
    const year = new Date().getFullYear();
    const rows: unknown = await (manager ?? this.dataSource).query(
      `
      WITH reserved AS (
        UPDATE code_sequence
        SET current_value = current_value + 1, updated_at = NOW()
        WHERE sequence_name = 'physical_inventory'
        RETURNING current_value, padding_length, prefix
      )
      SELECT current_value, padding_length, prefix FROM reserved
      `,
    );
    const row =
      Array.isArray(rows) && rows[0] && typeof rows[0] === 'object'
        ? (rows[0] as {
            current_value?: string | number;
            padding_length?: number;
            prefix?: string;
          })
        : null;
    const value = Number(row?.current_value ?? 0);
    const padding = Number(row?.padding_length ?? 3);
    const prefix = typeof row?.prefix === 'string' ? row.prefix : 'TF-';
    return `${prefix}${year}-${String(value).padStart(padding, '0')}`;
  }

  requireById(id: string): Promise<PhysicalInventory> {
    return this.requireInventory(id);
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
      throw new ApiException(ErrorCode.InvalidState);
    }
    return inventory;
  }

  private async requireAsset(id: string): Promise<Asset> {
    const asset = await this.assets.findOne({ where: { id } });
    if (!asset) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return asset;
  }

  private async toSummary(inventory: PhysicalInventory) {
    return inventorySummary(
      inventory,
      await loadResponsibleNames(this.dataSource, inventorySummaryUserIds(inventory)),
    );
  }
}
