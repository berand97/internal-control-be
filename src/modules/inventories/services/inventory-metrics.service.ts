import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import type { AppConfig } from '../../../config/configuration.js';
import { PermissionsService } from '../../roles/services/permissions.service.js';
import {
  coverageOf,
  firstActBlockedReason,
  isExpectedItem,
  isLiveSurplus,
  isMissingWithoutCause,
  isUnresolvedSurplus,
  isVerifiedItem,
  itemPhotoCount,
  locationAccuracyOf,
  missingStatsOf,
  surplusStatsOf,
  type CloseCheckCode,
} from '../domain/inventory-metrics.js';
import type {
  DashboardInventorySummaryDto,
  InventoryActivityResponseDto,
  InventoryCloseReadinessResponseDto,
  InventoryMetricsResponseDto,
  InventoryProgressByCostCenterResponseDto,
  InventoryProgressByLocationResponseDto,
  InventoryQueueResponseDto,
  InventorySessionsResponseDto,
} from '../dto/inventory-metrics.responses.js';
import { PhysicalInventory } from '../entities/physical-inventory.entity.js';
import { PhysicalInventoryItem } from '../entities/physical-inventory-item.entity.js';
import { InventoryStatus } from '../enums/inventory-status.js';
import { VerificationResult } from '../enums/verification-result.js';
import { InventoryValuationService } from './inventory-valuation.service.js';
import { loadResponsibleNames } from './inventory-summary.js';

@Injectable()
export class InventoryMetricsService {
  constructor(
    @InjectRepository(PhysicalInventory)
    private readonly inventories: Repository<PhysicalInventory>,
    @InjectRepository(PhysicalInventoryItem)
    private readonly items: Repository<PhysicalInventoryItem>,
    private readonly dataSource: DataSource,
    private readonly valuation: InventoryValuationService,
    private readonly permissions: PermissionsService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  get coverageTarget(): number {
    return this.config.getOrThrow('inventories', { infer: true }).coverageTarget;
  }

  get materialityAmount(): number {
    return this.config.getOrThrow('inventories', { infer: true }).materialityAmount;
  }

  async metrics(inventoryId: string): Promise<InventoryMetricsResponseDto> {
    const { inventory, items, photoCounts, valuations, basis } = await this.load(inventoryId);
    const coverage = coverageOf(items);
    const locationAccuracy = locationAccuracyOf(items);
    const missing = missingStatsOf(items, valuations, this.materialityAmount, photoCounts);
    const surplus = surplusStatsOf(items);
    const expected = items.filter(isExpectedItem);
    return {
      inventoryId: inventory.id,
      coverage: {
        ...coverage,
        target: this.coverageTarget,
        meetsTarget: coverage.percent !== null && coverage.percent >= this.coverageTarget,
      },
      locationAccuracy,
      missing,
      surplus,
      onLoan: expected.filter((item) => item.isOnLoan).length,
      temporaryCode: expected.filter((item) => item.expectedCodeTemporary === true).length,
      valuationDate: basis.valuationDate,
      generatedAt: new Date().toISOString(),
    };
  }

  async progressByLocation(inventoryId: string): Promise<InventoryProgressByLocationResponseDto> {
    const { items } = await this.load(inventoryId);
    const expected = items.filter(isExpectedItem);
    const locationIds = [
      ...new Set(expected.map((item) => item.expectedLocationId).filter((id): id is string => !!id)),
    ];
    const names = new Map<string, string>();
    if (locationIds.length > 0) {
      const rows = (await this.dataSource.query(
        `SELECT id, name FROM location WHERE id = ANY($1::uuid[])`,
        [locationIds],
      )) as Array<{ id: string; name: string }>;
      for (const row of rows) {
        names.set(row.id, row.name);
      }
    }
    const groups = new Map<string | null, PhysicalInventoryItem[]>();
    for (const item of expected) {
      const key = item.expectedLocationId;
      const list = groups.get(key) ?? [];
      list.push(item);
      groups.set(key, list);
    }
    const itemsOut = [...groups.entries()]
      .map(([locationId, group]) => ({
        locationId,
        name: locationId ? (names.get(locationId) ?? null) : 'Sin ubicación',
        expected: group.length,
        verified: group.filter(isVerifiedItem).length,
        pending: group.filter((item) => item.verificationResult === VerificationResult.Pending).length,
        misplaced: group.filter((item) => item.verificationResult === VerificationResult.Misplaced).length,
        notFound: group.filter((item) => item.verificationResult === VerificationResult.Missing).length,
        assignedTo: null,
      }))
      .sort((left, right) => (left.name ?? '').localeCompare(right.name ?? '', 'es'));
    return { items: itemsOut };
  }

  async progressByCostCenter(inventoryId: string): Promise<InventoryProgressByCostCenterResponseDto> {
    const { items, inventory } = await this.load(inventoryId);
    const centerIds = [
      ...new Set(
        items
          .map((item) => item.expectedCostCenterId ?? (isLiveSurplus(item) ? item.surplusCostCenterId : null))
          .filter((id): id is string => !!id),
      ),
    ];
    const centers = new Map<string, { code: string; name: string }>();
    if (centerIds.length > 0) {
      const rows = (await this.dataSource.query(
        `SELECT id, external_code AS code, name FROM cost_center WHERE id = ANY($1::uuid[])`,
        [centerIds],
      )) as Array<{ id: string; code: string; name: string }>;
      for (const row of rows) {
        centers.set(row.id, { code: row.code, name: row.name });
      }
    }
    const signers = new Map<string, string | null>();
    if (centerIds.length > 0) {
      const rows = (await this.dataSource.query(
        `SELECT cost_center_id, signer_head_person_id
         FROM physical_inventory_act WHERE inventory_id = $1 AND cost_center_id = ANY($2::uuid[])`,
        [inventoryId, centerIds],
      )) as Array<{ cost_center_id: string; signer_head_person_id: string | null }>;
      for (const row of rows) {
        signers.set(row.cost_center_id, row.signer_head_person_id);
      }
      const headRows = (await this.dataSource.query(
        `SELECT cost_center_id, count(*)::int AS n
         FROM cost_center_head
         WHERE cost_center_id = ANY($1::uuid[])
           AND valid_from <= NOW() AND (valid_until IS NULL OR valid_until > NOW())
         GROUP BY cost_center_id`,
        [centerIds],
      )) as Array<{ cost_center_id: string; n: number }>;
      for (const row of headRows) {
        if (!signers.has(row.cost_center_id) && row.n === 1) {
          signers.set(row.cost_center_id, 'AUTO');
        } else if (!signers.has(row.cost_center_id)) {
          signers.set(row.cost_center_id, null);
        }
      }
    }

    const grouped = new Map<string, PhysicalInventoryItem[]>();
    for (const item of items) {
      const centerId = item.expectedCostCenterId ?? (isLiveSurplus(item) ? item.surplusCostCenterId : null);
      if (!centerId) {
        continue;
      }
      const list = grouped.get(centerId) ?? [];
      list.push(item);
      grouped.set(centerId, list);
    }

    const agreementRows = (await this.dataSource.query(
      `SELECT act.cost_center_id, a.status, a.responded_at
       FROM physical_inventory_act_agreement a
       JOIN physical_inventory_act act ON act.id = a.act_id
       WHERE act.inventory_id = $1`,
      [inventoryId],
    )) as Array<{ cost_center_id: string; status: 'PENDING' | 'AGREED' | 'OBJECTED'; responded_at: Date | null }>;
    const agreements = new Map(
      agreementRows.map((row) => [row.cost_center_id, { status: row.status, respondedAt: row.responded_at }]),
    );
    const closed =
      inventory.status === InventoryStatus.Closed || inventory.status === InventoryStatus.Reconciled;

    const out = [...grouped.entries()].map(([costCenterId, group]) => {
      const coverage = coverageOf(group);
      const missingWithoutCause = group.filter(isMissingWithoutCause).length;
      const unresolvedSurplus = group.filter(isUnresolvedSurplus).length;
      const hasSigner = !!signers.get(costCenterId);
      const agreement = agreements.get(costCenterId);
      const agreementStatus = closed
        ? (agreement?.status ?? (hasSigner ? ('PENDING' as const) : undefined))
        : undefined;
      const actBlockedReason = firstActBlockedReason({
        coveragePercent: coverage.percent,
        coverageTarget: this.coverageTarget,
        missingWithoutCause,
        unresolvedSurplus,
        hasSigner,
        ...(agreementStatus ? { agreementStatus } : {}),
      });
      const meta = centers.get(costCenterId) ?? { code: costCenterId.slice(0, 8), name: 'Centro' };
      return {
        costCenterId,
        code: meta.code,
        name: meta.name,
        expected: coverage.expected,
        verified: coverage.verified,
        percent: coverage.percent,
        actReady: actBlockedReason === null,
        actBlockedReason,
        agreementStatus: agreement?.status ?? null,
        agreementRespondedAt: agreement?.respondedAt?.toISOString() ?? null,
      };
    });
    out.sort((left, right) => left.code.localeCompare(right.code, 'es'));
    return { items: out };
  }

  async queue(
    inventoryId: string,
    locationId: string | undefined,
    page: number,
    pageSize: number,
  ): Promise<InventoryQueueResponseDto> {
    const { items } = await this.load(inventoryId);
    const pending = items
      .filter(
        (item) =>
          item.verificationResult === VerificationResult.Pending &&
          (locationId ? item.expectedLocationId === locationId : true),
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    const total = pending.length;
    const slice = pending.slice((page - 1) * pageSize, page * pageSize);
    const assetIds = slice.map((item) => item.assetId).filter((id): id is string => !!id);
    const assets = new Map<string, { code: string | null; description: string | null }>();
    if (assetIds.length > 0) {
      const rows = (await this.dataSource.query(
        `SELECT id,
                coalesce(nullif(barcode, ''), nullif(serial_number, ''), internal_code) AS code,
                description
         FROM asset WHERE id = ANY($1::uuid[])`,
        [assetIds],
      )) as Array<{ id: string; code: string | null; description: string | null }>;
      for (const row of rows) {
        assets.set(row.id, { code: row.code, description: row.description });
      }
    }
    return {
      items: slice.map((item) => ({
        itemId: item.id,
        assetCode: item.assetId ? (assets.get(item.assetId)?.code ?? null) : null,
        assetDescription: item.assetId ? (assets.get(item.assetId)?.description ?? null) : null,
        status: 'PENDING' as const,
        expectedLocationId: item.expectedLocationId,
      })),
      page,
      pageSize,
      total,
    };
  }

  async activity(inventoryId: string, limit: number): Promise<InventoryActivityResponseDto> {
    await this.requireInventory(inventoryId);
    const verified = (await this.dataSource.query(
      `SELECT i.verified_at AS at, i.verified_by AS "userId", i.verification_result AS result,
              coalesce(nullif(a.barcode, ''), nullif(a.serial_number, ''), a.internal_code) AS "assetCode"
       FROM physical_inventory_item i
       LEFT JOIN asset a ON a.id = i.asset_id
       WHERE i.inventory_id = $1 AND i.verified_at IS NOT NULL AND i.verified_by IS NOT NULL
         AND i.verification_result IN ('FOUND', 'MISPLACED', 'MISSING', 'SURPLUS')
       ORDER BY i.verified_at DESC
       LIMIT $2`,
      [inventoryId, limit],
    )) as Array<{ at: Date; userId: string; result: string; assetCode: string | null }>;

    const corrections = (await this.dataSource.query(
      `SELECT c.corrected_at AS at, c.corrected_by AS "userId", c.kind,
              coalesce(nullif(a.barcode, ''), nullif(a.serial_number, ''), a.internal_code) AS "assetCode",
              c.after->>'verificationResult' AS result
       FROM inventory_item_correction c
       JOIN physical_inventory_item i ON i.id = c.item_id
       LEFT JOIN asset a ON a.id = coalesce(i.asset_id, i.resolved_asset_id)
       WHERE c.inventory_id = $1
       ORDER BY c.corrected_at DESC
       LIMIT $2`,
      [inventoryId, limit],
    )) as Array<{ at: Date; userId: string; kind: string; assetCode: string | null; result: string | null }>;

    const surplus = (await this.dataSource.query(
      `SELECT i.resolved_at AS at, i.resolved_by AS "userId",
              coalesce(nullif(a.barcode, ''), nullif(a.serial_number, ''), a.internal_code) AS "assetCode",
              i.surplus_resolution AS result
       FROM physical_inventory_item i
       LEFT JOIN asset a ON a.id = coalesce(i.resolved_asset_id, i.asset_id)
       WHERE i.inventory_id = $1 AND i.resolved_at IS NOT NULL AND i.resolved_by IS NOT NULL
       ORDER BY i.resolved_at DESC
       LIMIT $2`,
      [inventoryId, limit],
    )) as Array<{ at: Date; userId: string; assetCode: string | null; result: string | null }>;

    const events = [
      ...verified.map((row) => ({
        at: row.at,
        userId: row.userId,
        action: 'VERIFIED' as const,
        assetCode: row.assetCode,
        result: row.result,
      })),
      ...corrections.map((row) => ({
        at: row.at,
        userId: row.userId,
        action: (row.kind === 'VOID' ? 'VOIDED' : 'CORRECTED') as 'VOIDED' | 'CORRECTED',
        assetCode: row.assetCode,
        result: row.result,
      })),
      ...surplus.map((row) => ({
        at: row.at,
        userId: row.userId,
        action: 'SURPLUS_RESOLVED' as const,
        assetCode: row.assetCode,
        result: row.result,
      })),
    ]
      .sort((left, right) => right.at.getTime() - left.at.getTime())
      .slice(0, limit);

    const names = await loadResponsibleNames(
      this.dataSource,
      events.map((event) => event.userId),
    );
    return {
      items: events.map((event) => ({
        at: event.at.toISOString(),
        userId: event.userId,
        userName: names.get(event.userId) ?? event.userId,
        action: event.action,
        assetCode: event.assetCode,
        result: event.result,
      })),
    };
  }

  async sessions(inventoryId: string): Promise<InventorySessionsResponseDto> {
    await this.requireInventory(inventoryId);
    const rows = (await this.dataSource.query(
      `SELECT i.verified_by AS "userId",
              count(*)::int AS "verifiedTotal",
              count(*) FILTER (WHERE i.verified_at::date = CURRENT_DATE)::int AS "verifiedToday",
              max(i.verified_at) AS "lastActivityAt"
       FROM physical_inventory_item i
       WHERE i.inventory_id = $1 AND i.verified_by IS NOT NULL AND i.verified_at IS NOT NULL
         AND i.verification_result IN ('FOUND', 'MISPLACED', 'MISSING', 'SURPLUS', 'NOT_VERIFIED')
       GROUP BY i.verified_by
       ORDER BY max(i.verified_at) DESC`,
      [inventoryId],
    )) as Array<{
      userId: string;
      verifiedTotal: number;
      verifiedToday: number;
      lastActivityAt: Date | null;
    }>;
    const names = await loadResponsibleNames(
      this.dataSource,
      rows.map((row) => row.userId),
    );
    return {
      items: rows.map((row) => ({
        userId: row.userId,
        name: names.get(row.userId) ?? row.userId,
        verifiedToday: row.verifiedToday,
        verifiedTotal: row.verifiedTotal,
        lastActivityAt: row.lastActivityAt?.toISOString() ?? null,
      })),
    };
  }

  async closeReadiness(
    inventoryId: string,
    actor: AuthenticatedUser,
  ): Promise<InventoryCloseReadinessResponseDto> {
    const { items, photoCounts } = await this.load(inventoryId);
    const coverage = coverageOf(items);
    const missingWithoutCause = items.filter(isMissingWithoutCause).length;
    const missingWithoutPhoto = items.filter(
      (item) =>
        item.verificationResult === VerificationResult.Missing && itemPhotoCount(item, photoCounts) < 1,
    ).length;
    const unresolvedSurplus = items.filter(isUnresolvedSurplus).length;
    const centers = [
      ...new Set(items.map((item) => item.expectedCostCenterId).filter((id): id is string => !!id)),
    ];
    let signersAssigned = centers.length === 0;
    if (centers.length > 0) {
      const headCounts = (await this.dataSource.query(
        `SELECT cost_center_id, count(*)::int AS n
         FROM cost_center_head
         WHERE cost_center_id = ANY($1::uuid[])
           AND valid_from <= NOW() AND (valid_until IS NULL OR valid_until > NOW())
         GROUP BY cost_center_id`,
        [centers],
      )) as Array<{ cost_center_id: string; n: number }>;
      const byCenter = new Map(headCounts.map((row) => [row.cost_center_id, row.n]));
      const chosen = (await this.dataSource.query(
        `SELECT cost_center_id FROM physical_inventory_act
         WHERE inventory_id = $1 AND signer_head_person_id IS NOT NULL`,
        [inventoryId],
      )) as Array<{ cost_center_id: string }>;
      const chosenSet = new Set(chosen.map((row) => row.cost_center_id));
      signersAssigned = centers.every((id) => (byCenter.get(id) ?? 0) === 1 || chosenSet.has(id));
    }

    const checks: Array<{ code: CloseCheckCode; passed: boolean; detail: Record<string, unknown> | null }> = [
      {
        code: 'COVERAGE_TARGET',
        passed: coverage.percent !== null && coverage.percent >= this.coverageTarget,
        detail: { percent: coverage.percent, target: this.coverageTarget },
      },
      {
        code: 'MISSING_HAVE_CAUSE',
        passed: missingWithoutCause === 0,
        detail: { count: missingWithoutCause },
      },
      {
        code: 'MISSING_HAVE_PHOTO',
        passed: missingWithoutPhoto === 0,
        detail: { count: missingWithoutPhoto },
      },
      {
        code: 'SURPLUS_RESOLVED',
        passed: unresolvedSurplus === 0,
        detail: { count: unresolvedSurplus },
      },
      {
        code: 'SIGNERS_ASSIGNED',
        passed: signersAssigned,
        detail: null,
      },
    ];
    const canCloseWithPending = await this.permissions.userHasPermission(actor.id, 'inventory:create:global');
    return {
      canClose: checks.every((check) => check.passed),
      canCloseWithPending,
      checks,
    };
  }

  async dashboardSummary(): Promise<DashboardInventorySummaryDto> {
    const openStatuses = [InventoryStatus.Planned, InventoryStatus.InProgress];
    const openRows = (await this.dataSource.query(
      `SELECT id FROM physical_inventory WHERE status = ANY($1::text[])`,
      [openStatuses],
    )) as Array<{ id: string }>;
    const open = openRows.length;
    let averageCoverage: number | null = null;
    let openMissing = 0;
    if (open > 0) {
      const percents: number[] = [];
      for (const row of openRows) {
        const items = await this.items.find({ where: { inventoryId: row.id } });
        const coverage = coverageOf(items);
        if (coverage.percent !== null) {
          percents.push(coverage.percent);
        }
        openMissing += items.filter((item) => item.verificationResult === VerificationResult.Missing).length;
      }
      averageCoverage =
        percents.length === 0
          ? null
          : Math.round((percents.reduce((sum, value) => sum + value, 0) / percents.length) * 10) / 10;
    }
    const pendingActs = (await this.dataSource.query(
      `SELECT count(*)::int AS count
       FROM physical_inventory_act a
       JOIN document_request r ON r.id = a.document_request_id
       JOIN document d ON d.id = r.document_id
       WHERE d.status = 'PENDING_SIGNATURE'`,
    ).catch(() => [{ count: 0 }])) as Array<{ count: number }>;
    return {
      open,
      averageCoverage,
      openMissing,
      actsPendingSignature: pendingActs[0]?.count ?? 0,
    };
  }

  async photoCounts(inventoryId: string): Promise<Map<string, number>> {
    const rows = (await this.dataSource.query(
      `SELECT item_id AS id, count(*)::int AS n
       FROM inventory_item_photo p
       JOIN physical_inventory_item i ON i.id = p.item_id
       WHERE i.inventory_id = $1
       GROUP BY item_id`,
      [inventoryId],
    ).catch(() => [])) as Array<{ id: string; n: number }>;
    return new Map(rows.map((row) => [row.id, row.n]));
  }

  private async load(inventoryId: string) {
    const inventory = await this.requireInventory(inventoryId);
    const items = await this.items.find({ where: { inventoryId } });
    const photoCounts = await this.photoCounts(inventoryId);
    const basis = await this.valuation.basis(inventory);
    const assetIds = items.flatMap((item) => [item.assetId, item.resolvedAssetId]).filter((id): id is string => !!id);
    const valuations = await this.valuation.valuations(inventory, assetIds, undefined, basis);
    return { inventory, items, photoCounts, valuations, basis };
  }

  private async requireInventory(id: string): Promise<PhysicalInventory> {
    const inventory = await this.inventories.findOne({ where: { id } });
    if (!inventory) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return inventory;
  }
}
