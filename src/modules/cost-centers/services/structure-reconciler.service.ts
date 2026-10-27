import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import { duplicateSiblingGroups } from '../../organizational-units/domain/unit-name.js';
import { longestPrefix } from '../domain/code-prefix.js';
import {
  ALL_SCOPE,
  changeCount,
  planStructureReconcile,
  type ReconcileCenter,
  type ReconcileCounts,
  type ReconcilePlan,
  type ReconcileScope,
  type ReconcileState,
  type ReconcileUnit,
} from '../domain/structure-reconcile.js';
import type {
  StructureCenterInArchivedUnitDto,
  StructurePendingDto,
  StructureReconcilePreviewDto,
  StructureReconcileResultDto,
  StructureUnitUnderArchivedParentDto,
} from '../dto/responses/structure-reconcile.responses.js';
import { CostCenterPlacementService, NO_REQUEST, type PlacementPatch, type RequestMeta } from './cost-center-placement.service.js';
import { type OrgHistoryEntry, OrgStructureHistoryService } from './org-structure-history.service.js';

export interface ReconcileContext extends RequestMeta {
  readonly actorId: string | null;
  readonly reason: string;
}

export const RECALCULATE_REASON = 'Recalcular estructura';
const USER_AGENT_MAX = 500;

const headLabel = (code: string | null, pending: boolean): string | null =>
  code ? (pending ? `${code} (pendiente)` : code) : null;

@Injectable()
export class StructureReconcilerService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly placements: CostCenterPlacementService,
    private readonly history: OrgStructureHistoryService,
    @Inject('AuditLogsRepository')
    private readonly auditLogs: AuditLogsRepository,
  ) {}

  async loadState(manager: EntityManager): Promise<ReconcileState> {
    const units = (await manager.query(
      `SELECT id, code, name, code_prefix AS "codePrefix", is_active AS "isActive",
              head_cost_center_id AS "headCostCenterId", head_cost_center_code AS "headCostCenterCode"
       FROM organizational_unit ORDER BY code`,
    )) as ReconcileUnit[];
    const centers = (await manager.query(
      `SELECT cc.id, cc.external_code AS code, cc.name, cc.is_active AS "isActive", cc.has_movement AS "hasMovement",
              cc.organizational_unit_id AS "unitId", cc.parent_id AS "parentId", coalesce(p.mode, 'AUTO') AS mode
       FROM cost_center cc
       LEFT JOIN cost_center_placement p ON p.cost_center_id = cc.id AND p.valid_until IS NULL
       ORDER BY cc.external_code`,
    )) as ReconcileCenter[];
    return { units, centers };
  }

  async plan(manager: EntityManager, scope: ReconcileScope = ALL_SCOPE): Promise<ReconcilePlan> {
    return planStructureReconcile(await this.loadState(manager), scope);
  }

  async apply(manager: EntityManager, plan: ReconcilePlan, context: ReconcileContext): Promise<ReconcileCounts> {
    const patches = new Map<string, { -readonly [K in keyof PlacementPatch]: PlacementPatch[K] }>();
    for (const item of plan.relocations) {
      patches.set(item.center.id, { ...patches.get(item.center.id), unitId: item.toUnit.id });
    }
    for (const item of plan.reparents) {
      patches.set(item.center.id, { ...patches.get(item.center.id), parentId: item.toParent?.id ?? null });
    }
    const ordered = [...patches.entries()].sort(
      ([, left], [, right]) => Number(Boolean(left.parentId)) - Number(Boolean(right.parentId)),
    );
    const placementContext = {
      reason: context.reason,
      actorId: context.actorId,
      ip: context.ip,
      userAgent: context.userAgent,
      source: 'AUTO' as const,
      mode: 'AUTO' as const,
    };
    for (const [centerId, patch] of ordered) {
      await this.placements.change(manager, centerId, patch, placementContext);
    }

    const entries: OrgHistoryEntry[] = [];
    for (const link of plan.headLinks) {
      await manager.query(
        `UPDATE organizational_unit SET head_cost_center_id = $2, head_cost_center_code = $3, updated_at = NOW()
         WHERE id = $1`,
        [link.unit.id, link.center.id, link.code],
      );
      entries.push({
        entityType: 'ORG_UNIT',
        entityId: link.unit.id,
        field: 'HEAD_COST_CENTER',
        oldValue: headLabel(link.previousCode, link.kind === 'LINKED'),
        newValue: link.code,
      });
    }
    for (const unlink of plan.headUnlinks) {
      await manager.query(
        `UPDATE organizational_unit SET head_cost_center_id = NULL, head_cost_center_code = $2, updated_at = NOW()
         WHERE id = $1`,
        [unlink.unit.id, unlink.code],
      );
      entries.push({
        entityType: 'ORG_UNIT',
        entityId: unlink.unit.id,
        field: 'HEAD_COST_CENTER',
        oldValue: unlink.center?.externalCode ?? unlink.code,
        newValue: headLabel(unlink.code, true) ?? '(ninguno)',
      });
    }
    await this.history.record(manager, entries, { actorId: context.actorId, source: 'AUTO', reason: context.reason });
    return plan.counts;
  }

  async reconcileWithin(manager: EntityManager, scope: ReconcileScope, context: ReconcileContext): Promise<ReconcileCounts> {
    const plan = await this.plan(manager, scope);
    if (changeCount(plan.counts) === 0) {
      return plan.counts;
    }
    await this.apply(manager, plan, context);
    await this.audit(manager, plan, context, scope.kind);
    return plan.counts;
  }

  async preview(): Promise<StructureReconcilePreviewDto> {
    return this.plan(this.dataSource.manager);
  }

  async reconcileAll(
    actorId: string,
    expectedHash: string | undefined,
    request: RequestMeta = NO_REQUEST,
  ): Promise<StructureReconcileResultDto> {
    return this.dataSource.transaction(async (manager) => {
      const plan = await this.plan(manager);
      if (expectedHash !== undefined && expectedHash !== plan.hash) {
        throw new ApiException(ErrorCode.StructureReconcileStale);
      }
      const context: ReconcileContext = { actorId, reason: RECALCULATE_REASON, ...request };
      await this.apply(manager, plan, context);
      await this.audit(manager, plan, context, 'ALL');
      return { counts: plan.counts, hash: plan.hash };
    });
  }

  async pending(): Promise<StructurePendingDto> {
    const manager = this.dataSource.manager;
    const state = await this.loadState(manager);
    const plan = planStructureReconcile(state);
    const prefixed = state.units
      .filter((unit) => unit.isActive && unit.codePrefix)
      .map((unit) => ({ ...unit, codePrefix: unit.codePrefix ?? '' }));
    return {
      pendingHeadCenters: state.units
        .filter((unit) => unit.isActive && unit.headCostCenterId === null && unit.headCostCenterCode !== null)
        .map((unit) => ({ unitId: unit.id, unitName: unit.name, prefix: unit.codePrefix, code: unit.headCostCenterCode ?? '' })),
      centersWithoutUnit: state.centers
        .filter((center) => center.isActive && !longestPrefix(center.code, prefixed))
        .map((center) => ({ id: center.id, code: center.code, name: center.name })),
      mismatches: await this.placements.prefixMismatches(),
      manualExceptions: plan.manualExceptions,
      unitsUnderArchivedParent: (await manager.query(
        `SELECT u.id, u.code, u.name, u.code_prefix AS "codePrefix", p.id AS "parentId", p.name AS "parentName"
         FROM organizational_unit u
         JOIN organizational_unit p ON p.id = u.parent_id
         WHERE u.is_active AND NOT p.is_active
         ORDER BY u.code`,
      )) as StructureUnitUnderArchivedParentDto[],
      centersInArchivedUnit: (await manager.query(
        `SELECT cc.id, cc.external_code AS code, cc.name, u.id AS "unitId", u.name AS "unitName"
         FROM cost_center cc
         JOIN organizational_unit u ON u.id = cc.organizational_unit_id
         WHERE cc.is_active AND NOT u.is_active
         ORDER BY cc.external_code`,
      )) as StructureCenterInArchivedUnitDto[],
      duplicateSiblingNames: await this.duplicateSiblingNames(manager),
    };
  }

  private async duplicateSiblingNames(manager: EntityManager): Promise<StructurePendingDto['duplicateSiblingNames']> {
    const units = (await manager.query(
      `SELECT u.id, u.code, u.name, u.parent_id AS "parentId", p.name AS "parentName"
       FROM organizational_unit u
       LEFT JOIN organizational_unit p ON p.id = u.parent_id
       WHERE u.is_active`,
    )) as Array<{ id: string; code: string; name: string; parentId: string | null; parentName: string | null }>;
    return duplicateSiblingGroups(units).map((group) => ({
      parentId: group[0]?.parentId ?? null,
      parentName: group[0]?.parentName ?? null,
      name: group[0]?.name ?? '',
      units: group.map((unit) => ({ id: unit.id, code: unit.code })),
    }));
  }

  async backToAuto(costCenterId: string, actorId: string, request: RequestMeta = NO_REQUEST): Promise<StructureReconcileResultDto> {
    return this.dataSource.transaction(async (manager) => {
      const [center] = (await manager.query('SELECT external_code FROM cost_center WHERE id = $1', [costCenterId])) as Array<{
        external_code: string;
      }>;
      if (!center) {
        throw new ApiException(ErrorCode.ResourceNotFound, 'No encontramos el centro de costo.');
      }
      const reason = `El centro ${center.external_code} vuelve a ubicación automática`;
      await this.placements.change(manager, costCenterId, {}, {
        reason,
        actorId,
        ip: request.ip,
        userAgent: request.userAgent,
        source: 'MANUAL',
        mode: 'AUTO',
      });
      const plan = await this.plan(manager, {
        kind: 'PARTIAL',
        prefixes: [],
        unitIds: [],
        centerIds: [costCenterId],
      });
      const context: ReconcileContext = { actorId, reason, ...request };
      await this.apply(manager, plan, context);
      await this.audit(manager, plan, context, 'PARTIAL');
      return { counts: plan.counts, hash: plan.hash };
    });
  }

  private async audit(
    manager: EntityManager,
    plan: ReconcilePlan,
    context: ReconcileContext,
    scope: ReconcileScope['kind'],
  ): Promise<void> {
    await this.auditLogs.record(
      {
        action: AuditAction.StructureReconciled,
        entityType: 'ORG_STRUCTURE',
        entityId: randomUUID(),
        performedBy: context.actorId,
        ipAddress: context.ip,
        userAgent: context.userAgent?.slice(0, USER_AGENT_MAX) ?? null,
        changes: { reason: context.reason, scope, counts: plan.counts, hash: plan.hash },
      },
      manager,
    );
  }
}
