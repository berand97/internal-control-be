import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, type EntityManager, In, Repository } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { AppUser } from '../../auth/entities/app-user.entity.js';
import { UserStatus } from '../../auth/enums/user-status.enum.js';
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
import {
  CloseInventoryDto,
  CreateInventoryDto,
  QueryInventoriesDto,
  ReportNotFoundDto,
  ReportUnexpectedDto,
  VerifyInventoryAssetDto,
} from '../dto/inventory.dto.js';
import { PhysicalInventory } from '../entities/physical-inventory.entity.js';
import { PhysicalInventoryItem } from '../entities/physical-inventory-item.entity.js';
import { PhysicalInventoryScope } from '../entities/physical-inventory-scope.entity.js';
import { InventoryScopeType } from '../enums/inventory-scope.js';
import {
  InventoryStatus,
  OPEN_INVENTORY_STATUSES,
} from '../enums/inventory-status.js';
import { VerificationResult } from '../enums/verification-result.js';

const ENTITY_TYPE = 'INVENTORY';

interface ScopeAssetRow {
  readonly id: string;
  readonly current_location_id: string | null;
  readonly physical_condition: PhysicalCondition;
  readonly current_cost_center_id: string;
  readonly operational_status: OperationalStatus;
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
  ) {}

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
    return {
      items: rows.map((row) => this.toSummary(row)),
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
    return {
      ...this.toSummary(inventory),
      items: items.map((item) => this.toItem(item)),
      progress: this.toProgress(items),
      report: this.toReport(items),
    };
  }

  async create(dto: CreateInventoryDto, actor: AuthenticatedUser) {
    this.assertScope(dto.scope, dto.scopeId);
    await this.requireScopeTarget(dto.scope, dto.scopeId ?? null);
    if (dto.plannedEndDate < dto.plannedStartDate) {
      throw new ApiException(ErrorCode.ValidationFailed);
    }
    const responsible = await this.users.findOne({
      where: { id: dto.responsibleUserId, status: UserStatus.Active },
    });
    if (!responsible) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    await this.assertNoOverlap(dto.scope, dto.scopeId ?? null, null);
    const code = await this.nextCode();
    const now = new Date();
    const inventory = await this.inventories.save(
      this.inventories.create({
        code,
        name: dto.name,
        plannedStartDate: dto.plannedStartDate.slice(0, 10),
        plannedEndDate: dto.plannedEndDate.slice(0, 10),
        actualStartDate: null,
        actualEndDate: null,
        status: InventoryStatus.Planned,
        responsibleUserId: dto.responsibleUserId,
        scopeType: dto.scope,
        scopeId: dto.scopeId ?? null,
        scopeNotes: dto.notes ?? null,
        closedAt: null,
        closedBy: null,
        reconcileRequestedAt: null,
        reconcileRequestedBy: null,
        reconcileApprovedAt: null,
        reconcileApprovedBy: null,
        discrepancyReport: null,
        createdAt: now,
        createdBy: actor.id,
      }),
    );
    if (dto.scope === InventoryScopeType.CostCenter && dto.scopeId) {
      await this.scopes.save(
        this.scopes.create({
          inventoryId: inventory.id,
          costCenterId: dto.scopeId,
        }),
      );
    }
    await this.auditLogsRepository.record({
      action: AuditAction.InventoryCreated,
      entityType: ENTITY_TYPE,
      entityId: inventory.id,
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
      changes: { code, scope: dto.scope, scopeId: dto.scopeId ?? null },
    });
    return this.toSummary(inventory);
  }

  async start(id: string, actor: AuthenticatedUser) {
    const inventory = await this.requireInventory(id);
    assertInventoryTransition(inventory.status, InventoryStatus.InProgress);
    await this.assertNoOverlap(
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
        isOnLoan: asset.operational_status === OperationalStatus.OnLoan,
        verifiedAt: null,
        verifiedBy: null,
        notes: asset.operational_status === OperationalStatus.OnLoan
          ? 'En préstamo — verificación remota permitida'
          : null,
        photoUrl: null,
      }),
    );
    for (let index = 0; index < rows.length; index += 500) {
      await this.items.save(rows.slice(index, index + 500));
    }
    inventory.status = InventoryStatus.InProgress;
    inventory.actualStartDate = isoDate(now);
    await this.inventories.save(inventory);
    await this.auditLogsRepository.record({
      action: AuditAction.InventoryStarted,
      entityType: ENTITY_TYPE,
      entityId: inventory.id,
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
      changes: { expectedAssets: assets.length },
    });
    return this.getById(inventory.id);
  }

  async verifyAsset(
    id: string,
    dto: VerifyInventoryAssetDto,
    actor: AuthenticatedUser,
  ) {
    const inventory = await this.requireInProgress(id);
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
    await this.assetState.apply({
      assetId: asset.id,
      actorId: actor.id,
      patch: { lastVerifiedAt: item.verifiedAt },
      movement: {
        type: MovementType.PhysicalVerification,
        reason: dto.notes ?? `Verificación ${inventory.code}`,
        documentReference: inventory.code,
        executedAt: item.verifiedAt,
        metadata: {
          inventoryId: inventory.id,
          result: item.verificationResult,
          observedLocationId: actualLocationId,
          observedCondition: dto.condition,
        },
      },
      alsoWrite: async (manager) => {
        await manager.getRepository(PhysicalInventoryItem).save(item);
      },
    });
    return this.toItem(item);
  }

  async reportNotFound(
    id: string,
    dto: ReportNotFoundDto,
    actor: AuthenticatedUser,
  ) {
    const inventory = await this.requireInProgress(id);
    const item = await this.items.findOne({
      where: { inventoryId: inventory.id, assetId: dto.assetId },
    });
    if (!item || item.verificationResult === VerificationResult.Surplus) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    if (item.verificationResult !== VerificationResult.Pending) {
      throw new ApiException(ErrorCode.InvalidState);
    }
    item.verificationResult = VerificationResult.Missing;
    item.notes = dto.notes ?? item.notes;
    item.verifiedAt = new Date();
    item.verifiedBy = actor.id;
    await this.items.save(item);
    return this.toItem(item);
  }

  async reportUnexpected(
    id: string,
    dto: ReportUnexpectedDto,
    actor: AuthenticatedUser,
  ) {
    const inventory = await this.requireInProgress(id);
    if (dto.assetId) {
      const existing = await this.items.findOne({
        where: { inventoryId: inventory.id, assetId: dto.assetId },
      });
      if (existing && existing.verificationResult !== VerificationResult.Surplus) {
        throw new ApiException(ErrorCode.InvalidState);
      }
      if (existing) {
        throw new ApiException(ErrorCode.InvalidState);
      }
      await this.requireAsset(dto.assetId);
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
        isOnLoan: false,
        verifiedAt: new Date(),
        verifiedBy: actor.id,
        notes: dto.notes ?? null,
        photoUrl: null,
      }),
    );
    return this.toItem(item);
  }

  async progress(id: string) {
    const inventory = await this.requireInventory(id);
    const items = await this.items.find({ where: { inventoryId: inventory.id } });
    return {
      inventoryId: inventory.id,
      status: inventory.status,
      ...this.toProgress(items),
    };
  }

  async close(id: string, dto: CloseInventoryDto, actor: AuthenticatedUser) {
    const inventory = await this.requireInventory(id);
    assertInventoryTransition(inventory.status, InventoryStatus.Closed);
    const items = await this.items.find({ where: { inventoryId: inventory.id } });
    const progress = this.toProgress(items);
    if (exceedsUnverifiedThreshold(progress.pending, progress.expected)) {
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
    const report = this.toReport(items);
    inventory.status = InventoryStatus.Closed;
    inventory.actualEndDate = isoDate();
    inventory.closedAt = new Date();
    inventory.closedBy = actor.id;
    inventory.discrepancyReport = report;
    await this.inventories.save(inventory);
    await this.auditLogsRepository.record({
      action: AuditAction.InventoryClosed,
      entityType: ENTITY_TYPE,
      entityId: inventory.id,
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
      changes: report,
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
      ...(inventory.discrepancyReport ?? this.toReport(items)),
    };
  }

  async requestReconcile(id: string, actor: AuthenticatedUser) {
    const inventory = await this.requireInventory(id);
    if (inventory.status !== InventoryStatus.Closed) {
      throw new ApiException(ErrorCode.InvalidState);
    }
    if (inventory.responsibleUserId !== actor.id) {
      throw new ApiException(ErrorCode.InsufficientPermissions);
    }
    if (inventory.reconcileRequestedBy) {
      throw new ApiException(ErrorCode.InvalidState);
    }
    inventory.reconcileRequestedAt = new Date();
    inventory.reconcileRequestedBy = actor.id;
    await this.inventories.save(inventory);
    return this.toSummary(inventory);
  }

  async approveReconcile(id: string, actor: AuthenticatedUser) {
    const inventory = await this.requireInventory(id);
    if (inventory.status !== InventoryStatus.Closed) {
      throw new ApiException(ErrorCode.InvalidState);
    }
    if (!inventory.reconcileRequestedBy) {
      throw new ApiException(ErrorCode.InvalidState);
    }
    if (inventory.reconcileRequestedBy === actor.id) {
      throw new ApiException(ErrorCode.InventoryReconcileSod);
    }
    const items = await this.items.find({ where: { inventoryId: inventory.id } });
    await this.dataSource.transaction(async (manager) => {
      for (const item of items) {
        if (!item.assetId) {
          continue;
        }
        if (item.verificationResult === VerificationResult.Misplaced) {
          await this.applyLocation(inventory, item, actor, manager);
        }
        if (item.verificationResult === VerificationResult.Missing) {
          await this.applyLost(inventory, item, actor, manager);
        }
        if (
          item.verificationResult === VerificationResult.Found &&
          item.actualCondition &&
          item.expectedCondition &&
          item.actualCondition !== item.expectedCondition
        ) {
          await this.applyCondition(inventory, item, actor, manager);
        }
      }
      inventory.status = InventoryStatus.Reconciled;
      inventory.reconcileApprovedAt = new Date();
      inventory.reconcileApprovedBy = actor.id;
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
          },
        },
        manager,
      );
    });
    return this.getById(inventory.id);
  }

  private async applyLocation(
    inventory: PhysicalInventory,
    item: PhysicalInventoryItem,
    actor: AuthenticatedUser,
    manager: EntityManager,
  ): Promise<void> {
    if (!item.assetId || !item.actualLocationId) {
      return;
    }
    const asset = await this.requireAssetWithin(item.assetId, manager);
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
          reason: `Reconciliación ${inventory.code}`,
          documentReference: inventory.code,
          requestedBy: inventory.reconcileRequestedBy,
          metadata: { inventoryId: inventory.id },
        },
      },
      manager,
    );
  }

  private async applyLost(
    inventory: PhysicalInventory,
    item: PhysicalInventoryItem,
    actor: AuthenticatedUser,
    manager: EntityManager,
  ): Promise<void> {
    if (!item.assetId) {
      return;
    }
    const asset = await this.requireAssetWithin(item.assetId, manager);
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
          reason: `Faltante en ${inventory.code} — inicia baja formal`,
          documentReference: inventory.code,
          requestedBy: inventory.reconcileRequestedBy,
          metadata: { inventoryId: inventory.id, result: 'MISSING' },
        },
      },
      manager,
    );
  }

  private async applyCondition(
    inventory: PhysicalInventory,
    item: PhysicalInventoryItem,
    actor: AuthenticatedUser,
    manager: EntityManager,
  ): Promise<void> {
    if (!item.assetId || !item.actualCondition) {
      return;
    }
    await this.assetState.apply(
      {
        assetId: item.assetId,
        actorId: actor.id,
        patch: { physicalCondition: item.actualCondition },
        movement: {
          type: MovementType.ConditionChange,
          reason: `Reconciliación ${inventory.code}`,
          documentReference: inventory.code,
          requestedBy: inventory.reconcileRequestedBy,
          metadata: { inventoryId: inventory.id },
        },
      },
      manager,
    );
  }

  private async requireAssetWithin(
    id: string,
    manager: EntityManager,
  ): Promise<Asset> {
    const asset = await manager.getRepository(Asset).findOne({ where: { id } });
    if (!asset) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return asset;
  }

  private assertScope(
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

  private async requireScopeTarget(
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

  private async assertNoOverlap(
    scopeType: InventoryScopeType,
    scopeId: string | null,
    excludeId: string | null,
  ): Promise<void> {
    const others = await this.inventories.find({
      where: { status: In([...OPEN_INVENTORY_STATUSES]) },
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
    const leftSql = this.scopeSql('a', left.type, left.id, 1);
    const rightSql = this.scopeSql(
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
    const scoped = this.scopeSql('a', scopeType, scopeId, 1);
    const rows: unknown = await this.dataSource.query(
      `
      SELECT a.id, a.current_location_id, a.physical_condition,
             a.current_cost_center_id, a.operational_status
      FROM asset a
      WHERE a.operational_status <> 'WRITTEN_OFF'
        AND (${scoped.sql})
      `,
      scoped.params,
    );
    if (!Array.isArray(rows)) {
      return [];
    }
    return rows as ScopeAssetRow[];
  }

  private scopeSql(
    alias: string,
    scopeType: InventoryScopeType,
    scopeId: string | null,
    paramIndex: number,
  ): { readonly sql: string; readonly params: ReadonlyArray<string> } {
    if (scopeType === InventoryScopeType.Global) {
      return { sql: 'TRUE', params: [] };
    }
    if (!scopeId) {
      return { sql: 'FALSE', params: [] };
    }
    const placeholder = `$${paramIndex}`;
    if (scopeType === InventoryScopeType.CostCenter) {
      return {
        sql: `${alias}.current_cost_center_id = ${placeholder}`,
        params: [scopeId],
      };
    }
    if (scopeType === InventoryScopeType.Location) {
      return {
        sql: `${alias}.current_location_id = ${placeholder}`,
        params: [scopeId],
      };
    }
    return {
      sql: `${alias}.current_cost_center_id IN (
        SELECT cc.id FROM cost_center cc
        WHERE cc.organizational_unit_id IN (
          WITH RECURSIVE tree AS (
            SELECT id FROM organizational_unit WHERE id = ${placeholder}
            UNION ALL
            SELECT u.id FROM organizational_unit u JOIN tree t ON u.parent_id = t.id
          )
          SELECT id FROM tree
        )
      )`,
      params: [scopeId],
    };
  }

  private async nextCode(): Promise<string> {
    const year = new Date().getFullYear();
    const rows: unknown = await this.dataSource.query(
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

  private toSummary(inventory: PhysicalInventory) {
    return {
      id: inventory.id,
      code: inventory.code,
      name: inventory.name,
      status: inventory.status,
      scope: inventory.scopeType,
      scopeId: inventory.scopeId,
      plannedStartDate: inventory.plannedStartDate,
      plannedEndDate: inventory.plannedEndDate,
      actualStartDate: inventory.actualStartDate,
      actualEndDate: inventory.actualEndDate,
      responsibleUserId: inventory.responsibleUserId,
      notes: inventory.scopeNotes,
      closedAt: inventory.closedAt,
      closedBy: inventory.closedBy,
      reconcileRequestedAt: inventory.reconcileRequestedAt,
      reconcileRequestedBy: inventory.reconcileRequestedBy,
      reconcileApprovedAt: inventory.reconcileApprovedAt,
      reconcileApprovedBy: inventory.reconcileApprovedBy,
      createdAt: inventory.createdAt,
      createdBy: inventory.createdBy,
    };
  }

  private toItem(item: PhysicalInventoryItem) {
    return {
      id: item.id,
      assetId: item.assetId,
      result: item.verificationResult,
      expectedLocationId: item.expectedLocationId,
      actualLocationId: item.actualLocationId,
      expectedCondition: item.expectedCondition,
      actualCondition: item.actualCondition,
      expectedCostCenterId: item.expectedCostCenterId,
      isOnLoan: item.isOnLoan,
      verifiedAt: item.verifiedAt,
      verifiedBy: item.verifiedBy,
      notes: item.notes,
    };
  }

  private toProgress(items: ReadonlyArray<PhysicalInventoryItem>) {
    const expected = items.filter(
      (item) => item.verificationResult !== VerificationResult.Surplus,
    );
    const pending = expected.filter(
      (item) => item.verificationResult === VerificationResult.Pending,
    ).length;
    const verified = expected.filter(
      (item) =>
        item.verificationResult === VerificationResult.Found ||
        item.verificationResult === VerificationResult.Misplaced,
    ).length;
    const notFound = expected.filter(
      (item) => item.verificationResult === VerificationResult.Missing,
    ).length;
    const misplaced = expected.filter(
      (item) => item.verificationResult === VerificationResult.Misplaced,
    ).length;
    const unexpected = items.filter(
      (item) => item.verificationResult === VerificationResult.Surplus,
    ).length;
    const onLoan = expected.filter((item) => item.isOnLoan).length;
    return {
      expected: expected.length,
      pending,
      verified,
      notFound,
      misplaced,
      unexpected,
      onLoan,
      percentVerified:
        expected.length === 0
          ? 100
          : Math.round((verified / expected.length) * 10000) / 100,
    };
  }

  private toReport(items: ReadonlyArray<PhysicalInventoryItem>) {
    const progress = this.toProgress(items);
    return {
      ...progress,
      verifiedItems: items
        .filter(
          (item) =>
            item.verificationResult === VerificationResult.Found ||
            item.verificationResult === VerificationResult.Misplaced,
        )
        .map((item) => this.toItem(item)),
      notFoundItems: items
        .filter((item) => item.verificationResult === VerificationResult.Missing)
        .map((item) => this.toItem(item)),
      locationDiscrepancies: items
        .filter((item) => item.verificationResult === VerificationResult.Misplaced)
        .map((item) => this.toItem(item)),
      unexpectedItems: items
        .filter((item) => item.verificationResult === VerificationResult.Surplus)
        .map((item) => this.toItem(item)),
    };
  }
}

const isoDate = (value: Date = new Date()): string => {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};
