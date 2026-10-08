import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
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
  StructurePendingDto,
  StructureReconcilePreviewDto,
  StructureReconcileResultDto,
} from '../dto/responses/structure-reconcile.responses.js';
import { CostCenterPlacementService, NO_REQUEST, type PlacementPatch, type RequestMeta } from './cost-center-placement.service.js';
import { type OrgHistoryEntry, OrgStructureHistoryService } from './org-structure-history.service.js';

export interface ReconcileContext extends RequestMeta {
  readonly actorId: string | null;
  /** Motivo legible: «Se creó la unidad 43», «Se creó el centro 1510», «Recalcular estructura». */
  readonly reason: string;
}

export const RECALCULATE_REASON = 'Recalcular estructura';
const USER_AGENT_MAX = 500;

const headLabel = (code: string | null, pending: boolean): string | null =>
  code ? (pending ? `${code} (pendiente)` : code) : null;

/**
 * Mantiene al día la estructura según los códigos (ver domain/structure-reconcile.ts): reubica y re-padrea los centros
 * AUTO, amarra/desamarra el centro propio de las unidades. Cada flujo que crea o cambia unidades o centros lo llama en
 * su MISMA transacción con un ámbito acotado (reconcileWithin); «Recalcular estructura» lo aplica completo.
 *
 * Historial: cada reubicación es una fila de cost_center_placement (source AUTO, mode AUTO, con el motivo) y cada
 * amarre un evento HEAD_COST_CENTER en org_structure_history (source AUTO). Auditoría STRUCTURE_RECONCILED con conteos.
 */
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

  /**
   * Escribe el plan en la transacción de quien llama. Primero los re-padres hacia «sin padre» (así un cambio intermedio
   * no cierra un ciclo), después el resto; luego los centros propios.
   */
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

  /**
   * Planea y aplica en la transacción de quien llama (disparadores). Audita solo si cambió algo. Devuelve los conteos.
   */
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

  /** «Recalcular estructura»: todo, en su propia transacción. 409 STRUCTURE_RECONCILE_STALE si el plan cambió. */
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
    };
  }

  /** Devuelve un centro a ubicación automática (fila nueva AUTO con el mismo estado) y lo concilia. */
  async backToAuto(costCenterId: string, actorId: string, request: RequestMeta = NO_REQUEST): Promise<StructureReconcileResultDto> {
    return this.dataSource.transaction(async (manager) => {
      const [center] = (await manager.query('SELECT external_code FROM cost_center WHERE id = $1', [costCenterId])) as Array<{
        external_code: string;
      }>;
      if (!center) {
        throw new ApiException(ErrorCode.ResourceNotFound, 'No existe el centro de costo');
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
