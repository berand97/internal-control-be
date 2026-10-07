import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import { CostCenterPlacementService } from '../../cost-centers/services/cost-center-placement.service.js';
import {
  type OrgHistoryEntry,
  OrgStructureHistoryService,
} from '../../cost-centers/services/org-structure-history.service.js';
import {
  decideCenterRemoval,
  decideUnitRemoval,
  historyReason,
  StructureRemovalService,
} from '../../cost-centers/services/structure-removal.service.js';
import { PermissionsService } from '../../roles/services/permissions.service.js';
import type {
  OrgChartConfirmDto,
  OrgChartPreviewDto,
  OrgChartSummaryDto,
} from '../dto/responses/org-chart.responses.js';
import {
  ORG_RELATION_TYPE_LABELS,
  ORG_UNIT_TYPE_LABELS,
  OrgRelationType,
  OrgUnitType,
} from '../enums/org-unit-type.enum.js';
import { orgChartExportRows } from './org-chart-export.js';
import { type CenterOp, type OrgChartPlan, planOrgChart, type UnitOp } from './org-chart-plan.js';
import {
  buildOrgChartWorkbook,
  type ExportCenterRow,
  type ExportUnitRow,
  parseOrgChartWorkbook,
} from './org-chart-workbook.js';
import type {
  OrgChartInput,
  OrgChartSnapshot,
  RemovalReferences,
  SnapshotCenter,
  SnapshotUnit,
} from './org-chart.types.js';

export interface OrgChartUpload {
  readonly buffer: Buffer;
  readonly originalname: string;
}

export interface OrgChartFile {
  readonly fileName: string;
  readonly body: Buffer;
}

const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;
const COST_CENTER_MANAGE = 'cost_center:manage:global';
const IMPORT_REASON = 'Importación del Excel del organigrama';
const NEW = 'new:';
/** Llave del candado de la importación del organigrama (pg_advisory_xact_lock): una confirmación a la vez. */
const ORG_CHART_LOCK = 43_512_025;

const today = (): string => new Date().toISOString().slice(0, 10);

const toSummary = (plan: OrgChartPlan): OrgChartSummaryDto => ({
  units: {
    created: plan.unitCounts.CREATED,
    renamed: plan.unitCounts.RENAMED,
    moved: plan.unitCounts.MOVED,
    retyped: plan.unitCounts.RETYPED,
    prefixChanged: plan.unitCounts.PREFIX_CHANGED,
    relationChanged: plan.unitCounts.RELATION_CHANGED,
    headChanged: plan.unitCounts.HEAD_CHANGED,
    reactivated: plan.unitCounts.REACTIVATED,
    archived: plan.unitCounts.ARCHIVED,
    deleted: plan.unitCounts.DELETED,
  },
  centers: {
    created: plan.centerCounts.CREATED,
    renamed: plan.centerCounts.RENAMED,
    recoded: plan.centerCounts.RECODED,
    relocated: plan.centerCounts.RELOCATED,
    movementChanged: plan.centerCounts.MOVEMENT_CHANGED,
    reactivated: plan.centerCounts.REACTIVATED,
    archived: plan.centerCounts.ARCHIVED,
    deleted: plan.centerCounts.DELETED,
  },
  totalChanges: plan.changes.length,
});

const unitPath = (code: string): string => code.toLowerCase();

/**
 * Excel del organigrama: exportación, plantilla, previsualización y confirmación.
 *
 * Servicio propio y síncrono (no usa staging/import-jobs): son unos cientos de filas, el plan se calcula en memoria y
 * la confirmación aplica todo en una sola transacción. La previsualización guarda las filas leídas
 * (org_chart_import); al confirmar se vuelve a planear sobre el estado de ese momento y solo se aplica si el plan es
 * idéntico (si alguien cambió el organigrama entre medio: 409 ORG_CHART_IMPORT_STALE).
 */
@Injectable()
export class OrgChartService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly placements: CostCenterPlacementService,
    private readonly removal: StructureRemovalService,
    private readonly history: OrgStructureHistoryService,
    private readonly permissions: PermissionsService,
    @Inject('AuditLogsRepository')
    private readonly auditLogs: AuditLogsRepository,
  ) {}

  async export(): Promise<OrgChartFile> {
    const { units, centers } = await this.loadState(this.dataSource.manager);
    const body = await buildOrgChartWorkbook(...orgChartExportRows(units, centers), {
      example: false,
      generatedAt: new Date(),
    });
    return { fileName: `organigrama-${today()}.xlsx`, body };
  }

  async template(): Promise<OrgChartFile> {
    const units: ExportUnitRow[] = [
      {
        depth: 0,
        prefix: '4',
        name: 'Vicerrectoría Financiera',
        typeLabel: ORG_UNIT_TYPE_LABELS[OrgUnitType.Vicerectorate],
        parent: null,
        relationLabel: ORG_RELATION_TYPE_LABELS[OrgRelationType.Authority],
        headCenter: '4010',
        isActive: true,
        code: null,
      },
    ];
    const centers: ExportCenterRow[] = [
      { depth: 0, code: '4010', name: 'VICERRECTORÍA FINANCIERA', hasMovement: true, unit: null, parent: null, assets: null, isActive: true },
    ];
    const body = await buildOrgChartWorkbook(units, centers, { example: true, generatedAt: new Date() });
    return { fileName: 'plantilla-organigrama.xlsx', body };
  }

  async preview(file: OrgChartUpload | undefined, actor: AuthenticatedUser): Promise<OrgChartPreviewDto> {
    if (!file || file.buffer.length === 0) {
      throw new ApiException(ErrorCode.OrgChartInvalidFile, 'Adjunte el archivo Excel del organigrama');
    }
    const input = await parseOrgChartWorkbook(file.buffer);
    const plan = await this.plan(this.dataSource.manager, input);
    const requiresCostCenterPermission = plan.centers.length > 0;
    const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS);
    const summary = toSummary(plan);
    const body = {
      fileName: file.originalname.slice(0, 255),
      expiresAt: expiresAt.toISOString(),
      canConfirm: plan.errors.length === 0 && plan.changes.length > 0,
      requiresCostCenterPermission,
      summary,
      changes: plan.changes,
      errors: plan.errors,
      warnings: plan.warnings,
    };
    const [row] = (await this.dataSource.query(
      `INSERT INTO org_chart_import (file_name, file_sha256, input_rows, plan_hash, summary, has_errors, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        body.fileName,
        createHash('sha256').update(file.buffer).digest('hex'),
        JSON.stringify(input),
        plan.hash,
        JSON.stringify(summary),
        plan.errors.length > 0,
        actor.id,
        expiresAt,
      ],
    )) as Array<{ id: string }>;
    return { previewId: row?.id ?? '', ...body };
  }

  async confirm(previewId: string, actor: AuthenticatedUser): Promise<OrgChartConfirmDto> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock($1)', [ORG_CHART_LOCK]);
      const [stored] = (await manager.query(
        `SELECT id, input_rows, plan_hash, status, expires_at FROM org_chart_import WHERE id = $1 FOR UPDATE`,
        [previewId],
      )) as Array<{ id: string; input_rows: OrgChartInput; plan_hash: string; status: string; expires_at: Date }>;
      if (!stored) {
        throw new ApiException(ErrorCode.ResourceNotFound, 'No existe esa previsualización del organigrama');
      }
      if (stored.status !== 'PREVIEWED' || stored.expires_at.getTime() < Date.now()) {
        throw new ApiException(ErrorCode.OrgChartImportClosed);
      }
      const plan = await this.plan(manager, stored.input_rows);
      if (plan.errors.length > 0) {
        throw new ApiException(
          ErrorCode.OrgChartImportHasErrors,
          undefined,
          plan.errors.slice(0, 50).map((issue) => ({
            field: `${issue.sheet}!${issue.rowNumber}${issue.column ? `:${issue.column}` : ''}`,
            message: issue.message,
          })),
        );
      }
      if (plan.hash !== stored.plan_hash) {
        throw new ApiException(ErrorCode.OrgChartImportStale);
      }
      if (plan.centers.length > 0 && !(await this.permissions.userHasPermission(actor.id, COST_CENTER_MANAGE))) {
        throw new ApiException(
          ErrorCode.InsufficientPermissions,
          `El archivo cambia centros de costo: requiere permiso ${COST_CENTER_MANAGE}`,
        );
      }
      await this.apply(manager, plan, actor);
      const confirmedAt = new Date();
      await manager.query(`UPDATE org_chart_import SET status = 'CONFIRMED', confirmed_at = $2 WHERE id = $1`, [
        stored.id,
        confirmedAt,
      ]);
      const summary = toSummary(plan);
      await this.auditLogs.record(
        {
          action: AuditAction.OrgChartImported,
          entityType: 'ORG_CHART_IMPORT',
          entityId: stored.id,
          performedBy: actor.id,
          ipAddress: null,
          userAgent: null,
          changes: { units: summary.units, centers: summary.centers, totalChanges: summary.totalChanges },
        },
        manager,
      );
      return { previewId: stored.id, confirmedAt: confirmedAt.toISOString(), summary };
    });
  }

  // ─── Estado y plan ──────────────────────────────────────────────────────────────────────────────────────────────

  private async loadState(
    manager: EntityManager,
  ): Promise<{ units: SnapshotUnit[]; centers: SnapshotCenter[] }> {
    const units = (await manager.query(
      `SELECT id, code, name, unit_type AS "unitType", parent_id AS "parentId", relation_type AS "relationType",
              head_cost_center_id AS "headCostCenterId", code_prefix AS "codePrefix", is_active AS "isActive"
       FROM organizational_unit ORDER BY code`,
    )) as SnapshotUnit[];
    const centers = (await manager.query(
      `SELECT cc.id, cc.external_code AS "externalCode", cc.name, cc.has_movement AS "hasMovement",
              cc.is_active AS "isActive", cc.organizational_unit_id AS "unitId", cc.parent_id AS "parentId",
              coalesce(a.count, 0)::int AS "activeAssets"
       FROM cost_center cc
       LEFT JOIN (SELECT current_cost_center_id, count(*) AS count FROM asset
                  WHERE operational_status <> 'WRITTEN_OFF' GROUP BY current_cost_center_id) a
         ON a.current_cost_center_id = cc.id
       ORDER BY cc.external_code`,
    )) as SnapshotCenter[];
    return { units, centers };
  }

  /** Planea dos veces: la primera dice qué filas piden ELIMINAR; con su historia leída, la segunda es la definitiva. */
  private async plan(manager: EntityManager, input: OrgChartInput): Promise<OrgChartPlan> {
    const { units, centers } = await this.loadState(manager);
    const draft = planOrgChart({ units, centers, removal: new Map() }, input);
    const removal = new Map<string, RemovalReferences>();
    for (const op of draft.units) {
      if (op.removal === 'DELETE' && op.existingId) {
        const check = await this.removal.inspectUnit(manager, op.existingId);
        removal.set(op.existingId, { history: historyReason(check.references) });
      }
    }
    for (const op of draft.centers) {
      if (op.removal === 'DELETE' && op.existingId) {
        const check = await this.removal.inspectCostCenter(manager, op.existingId);
        removal.set(op.existingId, { history: historyReason(check.references) });
      }
    }
    if (removal.size === 0) {
      return draft;
    }
    return planOrgChart({ units, centers, removal } satisfies OrgChartSnapshot, input);
  }

  // ─── Aplicación ─────────────────────────────────────────────────────────────────────────────────────────────────

  private async apply(manager: EntityManager, plan: OrgChartPlan, actor: AuthenticatedUser): Promise<void> {
    const before = await this.loadState(manager);
    const unitBefore = new Map(before.units.map((unit) => [unit.id, unit]));
    const centerBefore = new Map(before.centers.map((center) => [center.id, center]));
    const unitIds = new Map<string, string>();
    const centerIds = new Map<string, string>();
    const unitId = (key: string | null): string | null => (key ? (key.startsWith(NEW) ? (unitIds.get(key) ?? null) : key) : null);
    const centerId = (key: string | null): string | null =>
      key ? (key.startsWith(NEW) ? (centerIds.get(key) ?? null) : key) : null;
    const historyEntries: OrgHistoryEntry[] = [];
    const placementContext = { reason: IMPORT_REASON, actorId: actor.id, source: 'IMPORT' as const, ip: null, userAgent: null };

    // 1. Libera prefijos que cambian y desactiva las unidades que se van (los centros se mueven después).
    const leaving = plan.units.filter((op) => op.existingId && (op.removal !== null || !op.isActive));
    const prefixMoves = plan.units.filter(
      (op) => op.existingId && unitBefore.get(op.existingId)?.codePrefix !== op.codePrefix,
    );
    if (leaving.length > 0) {
      await manager.query('UPDATE organizational_unit SET is_active = FALSE, updated_at = NOW() WHERE id = ANY($1::uuid[])', [
        leaving.map((op) => op.existingId),
      ]);
    }
    if (prefixMoves.length > 0) {
      await manager.query('UPDATE organizational_unit SET code_prefix = NULL WHERE id = ANY($1::uuid[])', [
        prefixMoves.map((op) => op.existingId),
      ]);
    }

    // 2. Unidades nuevas (sin padre todavía) y padres que cambian en dos pasos (sin ciclos intermedios).
    for (const op of plan.units.filter((item) => !item.existingId)) {
      const [row] = (await manager.query(
        `INSERT INTO organizational_unit (code, name, unit_type, relation_type, code_prefix, parent_id, hierarchy_level,
           hierarchy_path, is_active)
         VALUES ($1, $2, $3, $4, $5, NULL, 0, $6, TRUE) RETURNING id`,
        [op.code, op.name, op.unitType, op.relationType, op.codePrefix, `/${unitPath(op.code)}`],
      )) as Array<{ id: string }>;
      unitIds.set(op.key, row?.id ?? '');
    }
    const moving = plan.units.filter((op) => op.existingId && op.kinds.includes('MOVED'));
    if (moving.length > 0) {
      await manager.query('UPDATE organizational_unit SET parent_id = NULL WHERE id = ANY($1::uuid[])', [
        moving.map((op) => op.existingId),
      ]);
    }
    for (const op of plan.units) {
      const id = unitId(op.key);
      if (!id || op.removal === 'DELETE') {
        continue;
      }
      await manager.query(
        `UPDATE organizational_unit
         SET name = $2, unit_type = $3, relation_type = $4, code_prefix = $5, parent_id = $6, is_active = $7, updated_at = NOW()
         WHERE id = $1`,
        [id, op.name, op.unitType, op.relationType, op.codePrefix, unitId(op.parentKey), op.isActive],
      );
    }
    await this.rewriteHierarchy(manager);

    // 3. Centros: recodificación, altas (por código: XYZ0 antes que XYZn) y cambios.
    for (const op of plan.centers.filter((item) => item.existingId && item.kinds.includes('RECODED'))) {
      await manager.query('UPDATE cost_center SET external_code = $2, updated_at = NOW() WHERE id = $1', [op.existingId, op.code]);
    }
    const created: string[] = [];
    for (const op of plan.centers.filter((item) => !item.existingId).sort((left, right) => left.code.localeCompare(right.code))) {
      const [row] = (await manager.query(
        `INSERT INTO cost_center (external_code, name, organizational_unit_id, parent_id, accepts_assets, has_movement,
           is_active, sync_source, last_synced_at)
         VALUES ($1, $2, $3, $4, $5, $5, TRUE, 'IMPORT_EXCEL', NOW()) RETURNING id`,
        [op.code, op.name, unitId(op.unitKey), centerId(op.parentKey), op.hasMovement],
      )) as Array<{ id: string }>;
      centerIds.set(op.key, row?.id ?? '');
      created.push(row?.id ?? '');
    }
    await this.placements.openMany(manager, created, { ...placementContext, reason: 'Alta desde el Excel del organigrama' });
    for (const op of plan.centers.filter((item) => item.existingId && item.removal !== 'DELETE')) {
      const id = op.existingId ?? '';
      const previous = centerBefore.get(id);
      if (op.kinds.includes('RENAMED') || op.kinds.includes('REACTIVATED') || op.kinds.includes('ARCHIVED')) {
        await manager.query('UPDATE cost_center SET name = $2, is_active = $3, updated_at = NOW() WHERE id = $1', [
          id,
          op.name,
          op.isActive,
        ]);
      }
      if (op.kinds.includes('RELOCATED') || op.kinds.includes('MOVEMENT_CHANGED')) {
        await this.placements.change(
          manager,
          id,
          { unitId: unitId(op.unitKey), parentId: centerId(op.parentKey), hasMovement: op.hasMovement },
          placementContext,
        );
        if (op.hasMovement && previous && !previous.hasMovement) {
          await manager.query('UPDATE cost_center SET accepts_assets = TRUE WHERE id = $1', [id]);
        }
      }
      if (previous) {
        historyEntries.push(
          { entityType: 'COST_CENTER', entityId: id, field: 'CODE', oldValue: previous.externalCode, newValue: op.code },
          { entityType: 'COST_CENTER', entityId: id, field: 'NAME', oldValue: previous.name, newValue: op.name },
          {
            entityType: 'COST_CENTER',
            entityId: id,
            field: 'STATUS',
            oldValue: previous.isActive ? 'ACTIVE' : 'ARCHIVED',
            newValue: op.isActive ? 'ACTIVE' : 'ARCHIVED',
          },
        );
      }
    }

    // 4. Centro propio de las unidades.
    for (const op of plan.units) {
      const id = unitId(op.key);
      if (!id || op.removal === 'DELETE' || !(op.kinds.includes('HEAD_CHANGED') || op.kinds.includes('CREATED'))) {
        continue;
      }
      await manager.query('UPDATE organizational_unit SET head_cost_center_id = $2 WHERE id = $1', [id, centerId(op.headCenterKey)]);
    }

    // 5. Bajas: centros y después unidades (revisando otra vez dentro de la transacción).
    for (const op of plan.centers.filter((item) => item.existingId && item.removal === 'DELETE')) {
      await this.removeCenter(manager, op, actor);
    }
    for (const op of plan.units.filter((item) => item.existingId && item.removal === 'DELETE')) {
      await this.removeUnit(manager, op, actor);
    }

    // 6. Historial de unidades.
    const label = (id: string | null): string | null => {
      if (!id) {
        return null;
      }
      const unit = unitBefore.get(id);
      if (unit) {
        return `${unit.codePrefix ? `${unit.codePrefix} · ` : ''}${unit.name}`;
      }
      const created = plan.units.find((op) => unitIds.get(op.key) === id);
      return created ? `${created.codePrefix ? `${created.codePrefix} · ` : ''}${created.name}` : id;
    };
    const centerCode = (id: string | null): string | null =>
      id ? (centerBefore.get(id)?.externalCode ?? plan.centers.find((op) => centerIds.get(op.key) === id)?.code ?? id) : null;
    for (const op of plan.units.filter((item) => item.existingId && item.removal !== 'DELETE')) {
      const id = op.existingId ?? '';
      const previous = unitBefore.get(id);
      if (!previous) {
        continue;
      }
      historyEntries.push(
        { entityType: 'ORG_UNIT', entityId: id, field: 'NAME', oldValue: previous.name, newValue: op.name },
        { entityType: 'ORG_UNIT', entityId: id, field: 'TYPE', oldValue: previous.unitType, newValue: op.unitType },
        { entityType: 'ORG_UNIT', entityId: id, field: 'PARENT', oldValue: label(previous.parentId), newValue: label(unitId(op.parentKey)) },
        { entityType: 'ORG_UNIT', entityId: id, field: 'PREFIX', oldValue: previous.codePrefix, newValue: op.codePrefix },
        { entityType: 'ORG_UNIT', entityId: id, field: 'RELATION', oldValue: previous.relationType, newValue: op.relationType },
        {
          entityType: 'ORG_UNIT',
          entityId: id,
          field: 'HEAD_COST_CENTER',
          oldValue: centerCode(previous.headCostCenterId),
          newValue: centerCode(centerId(op.headCenterKey)),
        },
        {
          entityType: 'ORG_UNIT',
          entityId: id,
          field: 'STATUS',
          oldValue: previous.isActive ? 'ACTIVE' : 'ARCHIVED',
          newValue: op.isActive ? 'ACTIVE' : 'ARCHIVED',
        },
      );
    }
    await this.history.record(manager, historyEntries, { actorId: actor.id, source: 'IMPORT', reason: IMPORT_REASON });
  }

  private async removeCenter(manager: EntityManager, op: CenterOp, actor: AuthenticatedUser): Promise<void> {
    const id = op.existingId ?? '';
    const verdict = decideCenterRemoval(await this.removal.inspectCostCenter(manager, id));
    if (verdict.decision === 'BLOCKED') {
      throw new ApiException(ErrorCode.OrgChartImportStale, `El centro ${op.code} ya no se puede eliminar: ${verdict.reason ?? ''}`);
    }
    if (verdict.decision === 'ARCHIVE') {
      throw new ApiException(ErrorCode.OrgChartImportStale);
    }
    await this.removal.deleteCostCenter(manager, id);
    await this.auditLogs.record(
      {
        action: AuditAction.CostCenterDeleted,
        entityType: 'COST_CENTER',
        entityId: id,
        performedBy: actor.id,
        ipAddress: null,
        userAgent: null,
        changes: { externalCode: op.code, name: op.name, physical: true, source: 'ORG_CHART_IMPORT' },
      },
      manager,
    );
  }

  private async removeUnit(manager: EntityManager, op: UnitOp, actor: AuthenticatedUser): Promise<void> {
    const id = op.existingId ?? '';
    const verdict = decideUnitRemoval(await this.removal.inspectUnit(manager, id));
    if (verdict.decision !== 'DELETE') {
      throw new ApiException(ErrorCode.OrgChartImportStale, `La unidad ${op.name} ya no se puede eliminar: ${verdict.reason ?? ''}`);
    }
    await this.removal.deleteUnit(manager, id);
    await this.auditLogs.record(
      {
        action: AuditAction.OrgUnitDeleted,
        entityType: 'ORG_UNIT',
        entityId: id,
        performedBy: actor.id,
        ipAddress: null,
        userAgent: null,
        changes: { code: op.code, name: op.name, codePrefix: op.codePrefix, physical: true, source: 'ORG_CHART_IMPORT' },
      },
      manager,
    );
  }

  /** Recalcula hierarchy_level y hierarchy_path de todas las unidades desde parent_id (solo escribe las que cambian). */
  private async rewriteHierarchy(manager: EntityManager): Promise<void> {
    const rows = (await manager.query(
      'SELECT id, parent_id, code, hierarchy_level, hierarchy_path FROM organizational_unit',
    )) as Array<{ id: string; parent_id: string | null; code: string; hierarchy_level: number; hierarchy_path: string | null }>;
    const byId = new Map(rows.map((row) => [row.id, row]));
    const computed = new Map<string, { level: number; path: string }>();
    const resolve = (id: string, guard: number): { level: number; path: string } => {
      const known = computed.get(id);
      if (known) {
        return known;
      }
      const row = byId.get(id);
      if (!row) {
        return { level: 0, path: '' };
      }
      const parent = row.parent_id && guard < 64 ? resolve(row.parent_id, guard + 1) : null;
      const value = parent
        ? { level: parent.level + 1, path: `${parent.path}/${unitPath(row.code)}` }
        : { level: 0, path: `/${unitPath(row.code)}` };
      computed.set(id, value);
      return value;
    };
    for (const row of rows) {
      const value = resolve(row.id, 0);
      if (value.level !== row.hierarchy_level || value.path !== row.hierarchy_path) {
        await manager.query(
          'UPDATE organizational_unit SET hierarchy_level = $2, hierarchy_path = $3, updated_at = NOW() WHERE id = $1',
          [row.id, value.level, value.path],
        );
      }
    }
  }
}
