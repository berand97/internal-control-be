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
import { ALL_SCOPE } from '../../cost-centers/domain/structure-reconcile.js';
import { StructureReconcilerService } from '../../cost-centers/services/structure-reconciler.service.js';
import type { OrgHistoryField } from '../../cost-centers/services/org-structure-history.service.js';
import { userDisplayNameSubquery } from '../../persons/services/cost-center-heads.service.js';
import { PermissionsService } from '../../roles/services/permissions.service.js';
import type {
  OrgChartAppliedBeforeDto,
  OrgChartConfirmDto,
  OrgChartPreviewDto,
  OrgChartSummaryDto,
} from '../dto/responses/org-chart.responses.js';
import { orgChartExportRows } from './org-chart-export.js';
import {
  type ChangeInfo,
  type DeletedUnitInfo,
  formatWhen,
  mergeOrgChartInput,
  type OrgChartConflict,
} from './org-chart-merge.js';
import { type CenterOp, type OrgChartPlan, planOrgChart, type UnitOp } from './org-chart-plan.js';
import { structureRevision } from './org-chart-stamp.js';
import { buildOrgChartWorkbook, parseOrgChartWorkbook } from './org-chart-workbook.js';
import {
  type OrgChartInput,
  type OrgChartSnapshot,
  type RemovalReferences,
  type SnapshotCenter,
  type SnapshotUnit,
  UNIT_SHEET,
  unitsOnly,
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
    colorChanged: plan.unitCounts.COLOR_CHANGED,
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

/** Plan del archivo: el de planOrgChart más lo que dijo el sello (conflictos, antigüedad, filas descartadas). */
type FilePlan = OrgChartPlan & {
  readonly conflicts: ReadonlyArray<OrgChartConflict>;
  readonly fileAgeDays: number | null;
};

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
    private readonly reconciler: StructureReconcilerService,
  ) {}

  async export(): Promise<OrgChartFile> {
    const { units, centers } = await this.loadState(this.dataSource.manager);
    const body = await buildOrgChartWorkbook(orgChartExportRows(units, centers), {
      kind: 'EXPORT',
      generatedAt: new Date(),
      revision: structureRevision(units),
    });
    return { fileName: `organigrama-${today()}.xlsx`, body };
  }

  /** Hoja Organigrama vacía: el ejemplo va en Instrucciones (subido tal cual no cambia nada). */
  async template(): Promise<OrgChartFile> {
    const body = await buildOrgChartWorkbook([], { kind: 'TEMPLATE', generatedAt: new Date(), revision: 'TEMPLATE' });
    return { fileName: 'plantilla-organigrama.xlsx', body };
  }

  async preview(file: OrgChartUpload | undefined, actor: AuthenticatedUser): Promise<OrgChartPreviewDto> {
    if (!file || file.buffer.length === 0) {
      throw new ApiException(ErrorCode.OrgChartInvalidFile, 'Adjunte el archivo Excel del organigrama');
    }
    const input = await parseOrgChartWorkbook(file.buffer);
    const fileSha256 = createHash('sha256').update(file.buffer).digest('hex');
    const plan = await this.plan(this.dataSource.manager, input);
    const fileAppliedBefore = await this.appliedBefore(fileSha256);
    const warnings = fileAppliedBefore
      ? [
          {
            sheet: UNIT_SHEET,
            rowNumber: 1,
            column: null,
            message: `Este archivo ya se aplicó el ${formatWhen(fileAppliedBefore.at)}${fileAppliedBefore.by ? ` por ${fileAppliedBefore.by}` : ''}`,
          },
          ...plan.warnings,
        ]
      : plan.warnings;
    // Siempre false: el Excel del organigrama no toca centros (se mantiene el campo por contrato).
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
      warnings,
      conflicts: plan.conflicts,
      fileAppliedBefore,
      fileAgeDays: plan.fileAgeDays,
    };
    const [row] = (await this.dataSource.query(
      `INSERT INTO org_chart_import (file_name, file_sha256, input_rows, plan_hash, summary, has_errors, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        body.fileName,
        fileSha256,
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
      if (plan.conflicts.length > 0) {
        throw new ApiException(
          ErrorCode.OrgChartImportConflict,
          undefined,
          plan.conflicts.slice(0, 50).map((conflict) => ({
            field: `${UNIT_SHEET}!${conflict.rowNumber}:${conflict.column}`,
            message: `${conflict.unitName}: en el sistema ${conflict.currentValue ?? '(vacío)'}; su archivo ${conflict.fileValue ?? '(vacío)'}`,
          })),
        );
      }
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
      // Nunca ocurre (unitsOnly): resguardo de la lógica de centros del plan, que el organigrama no usa.
      if (plan.centers.length > 0 && !(await this.permissions.userHasPermission(actor.id, COST_CENTER_MANAGE))) {
        throw new ApiException(
          ErrorCode.InsufficientPermissions,
          `El archivo cambia centros de costo: requiere permiso ${COST_CENTER_MANAGE}`,
        );
      }
      await this.apply(manager, plan, actor);
      // Unidades nuevas, prefijos que cambian, centros propios pendientes: la estructura completa se concilia aquí.
      await this.reconciler.reconcileWithin(manager, ALL_SCOPE, {
        actorId: actor.id,
        reason: IMPORT_REASON,
        ip: null,
        userAgent: null,
      });
      const confirmedAt = new Date();
      await manager.query(
        `UPDATE org_chart_import SET status = 'CONFIRMED', confirmed_at = $2, confirmed_by = $3 WHERE id = $1`,
        [stored.id, confirmedAt, actor.id],
      );
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
              head_cost_center_id AS "headCostCenterId",
              head_cost_center_code AS "headCostCenterCode", code_prefix AS "codePrefix", is_active AS "isActive", color
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

  /** Última confirmación de un archivo idéntico (mismo hash del contenido). */
  private async appliedBefore(fileSha256: string): Promise<OrgChartAppliedBeforeDto | null> {
    const [row] = (await this.dataSource.query(
      `SELECT i.confirmed_at AS at, ${userDisplayNameSubquery('coalesce(i.confirmed_by, i.created_by)')} AS by
       FROM org_chart_import i
       WHERE i.file_sha256 = $1 AND i.status = 'CONFIRMED'
       ORDER BY i.confirmed_at DESC LIMIT 1`,
      [fileSha256],
    )) as Array<{ at: Date; by: string | null }>;
    return row ? { at: row.at.toISOString(), by: row.by } : null;
  }

  /** Lo que el sello necesita saber del historial: último cambio por campo, eliminadas y creación de cada unidad. */
  private async loadMergeContext(
    manager: EntityManager,
    codes: ReadonlyArray<string>,
  ): Promise<{
    lastChanges: Map<string, Map<OrgHistoryField, ChangeInfo>>;
    deletedUnits: Map<string, DeletedUnitInfo>;
    unitOrigins: Map<string, ChangeInfo>;
  }> {
    const changes = (await manager.query(
      `SELECT DISTINCT ON (h.entity_id, h.field) h.entity_id AS "unitId", h.field, h.changed_at AS at,
              ${userDisplayNameSubquery('h.changed_by')} AS "byName"
       FROM org_structure_history h
       WHERE h.entity_type = 'ORG_UNIT'
       ORDER BY h.entity_id, h.field, h.changed_at DESC, h.id DESC`,
    )) as Array<{ unitId: string; field: OrgHistoryField; at: Date; byName: string | null }>;
    const lastChanges = new Map<string, Map<OrgHistoryField, ChangeInfo>>();
    for (const row of changes) {
      const fields = lastChanges.get(row.unitId) ?? new Map<OrgHistoryField, ChangeInfo>();
      fields.set(row.field, { at: row.at.toISOString(), byName: row.byName });
      lastChanges.set(row.unitId, fields);
    }
    const deleted =
      codes.length === 0
        ? []
        : ((await manager.query(
            `SELECT DISTINCT ON (a.changes->>'code') a.changes->>'code' AS code, a.changes->>'name' AS name,
                    a.performed_at AS at, ${userDisplayNameSubquery('a.performed_by')} AS "byName"
             FROM audit_log a
             WHERE a.entity_type = 'ORG_UNIT' AND a.action = $1 AND a.changes->>'code' = ANY($2::text[])
             ORDER BY a.changes->>'code', a.performed_at DESC`,
            [AuditAction.OrgUnitDeleted, codes],
          )) as Array<{ code: string; name: string | null; at: Date; byName: string | null }>);
    const origins = (await manager.query(
      `SELECT u.id, u.created_at AS at,
              (SELECT ${userDisplayNameSubquery('a.performed_by')} FROM audit_log a
               WHERE a.entity_type = 'ORG_UNIT' AND a.entity_id = u.id AND a.action = $1
               ORDER BY a.performed_at LIMIT 1) AS "byName"
       FROM organizational_unit u WHERE u.is_active`,
      [AuditAction.OrgUnitCreated],
    )) as Array<{ id: string; at: Date; byName: string | null }>;
    return {
      lastChanges,
      deletedUnits: new Map(deleted.map((row) => [row.code, { at: row.at.toISOString(), byName: row.byName, name: row.name }])),
      unitOrigins: new Map(origins.map((row) => [row.id, { at: row.at.toISOString(), byName: row.byName }])),
    };
  }

  /**
   * Ajusta las filas con el sello (mergeOrgChartInput) y planea dos veces: la primera dice qué filas piden ELIMINAR;
   * con su historia leída, la segunda es la definitiva. Solo unidades (unitsOnly): también las previsualizaciones
   * guardadas con filas de centros las descartan.
   */
  private async plan(manager: EntityManager, rows: OrgChartInput): Promise<FilePlan> {
    const { units, centers } = await this.loadState(manager);
    const known = new Set(units.flatMap((unit) => [unit.code, unit.code.toUpperCase()]));
    const missingCodes = [
      ...new Set(
        rows.units.flatMap((row) => (row.code && !known.has(row.code) ? [row.code, row.code.toUpperCase()] : [])),
      ),
    ];
    const merge = mergeOrgChartInput(unitsOnly(rows), {
      units,
      centers,
      ...(await this.loadMergeContext(manager, missingCodes)),
      now: new Date(),
    });
    const input = merge.input;
    let plan = planOrgChart({ units, centers, removal: new Map() }, input);
    const removal = new Map<string, RemovalReferences>();
    for (const op of plan.units) {
      if (op.removal === 'DELETE' && op.existingId) {
        const check = await this.removal.inspectUnit(manager, op.existingId);
        removal.set(op.existingId, { history: historyReason(check.references) });
      }
    }
    for (const op of plan.centers) {
      if (op.removal === 'DELETE' && op.existingId) {
        const check = await this.removal.inspectCostCenter(manager, op.existingId);
        removal.set(op.existingId, { history: historyReason(check.references) });
      }
    }
    if (removal.size > 0) {
      plan = planOrgChart({ units, centers, removal } satisfies OrgChartSnapshot, input);
    }
    return {
      ...plan,
      errors: [...merge.errors, ...plan.errors],
      warnings: [...merge.warnings, ...plan.warnings],
      conflicts: merge.conflicts,
      fileAgeDays: merge.fileAgeDays,
    };
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
    const centerCode = (id: string | null): string | null =>
      id ? (centerBefore.get(id)?.externalCode ?? plan.centers.find((op) => centerIds.get(op.key) === id)?.code ?? id) : null;
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
           hierarchy_path, is_active, color)
         VALUES ($1, $2, $3, $4, $5, NULL, 0, $6, TRUE, $7) RETURNING id`,
        [op.code, op.name, op.unitType, op.relationType, op.codePrefix, `/${unitPath(op.code)}`, op.color],
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
         SET name = $2, unit_type = $3, relation_type = $4, code_prefix = $5, parent_id = $6, is_active = $7, color = $8,
             updated_at = NOW()
         WHERE id = $1`,
        [id, op.name, op.unitType, op.relationType, op.codePrefix, unitId(op.parentKey), op.isActive, op.color],
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
      const headId = centerId(op.headCenterKey);
      await manager.query(
        'UPDATE organizational_unit SET head_cost_center_id = $2, head_cost_center_code = $3 WHERE id = $1',
        [id, headId, headId ? (centerCode(headId) ?? op.headCenterCode) : op.headCenterCode],
      );
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
    const headLabel = (id: string | null, code: string | null): string | null =>
      id ? centerCode(id) : code ? `${code} (pendiente)` : null;
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
          oldValue: headLabel(previous.headCostCenterId, previous.headCostCenterCode),
          newValue: headLabel(centerId(op.headCenterKey), op.headCenterCode),
        },
        {
          entityType: 'ORG_UNIT',
          entityId: id,
          field: 'STATUS',
          oldValue: previous.isActive ? 'ACTIVE' : 'ARCHIVED',
          newValue: op.isActive ? 'ACTIVE' : 'ARCHIVED',
        },
        // null en newValue: color quitado (hereda el de su jefe).
        { entityType: 'ORG_UNIT', entityId: id, field: 'COLOR', oldValue: previous.color ?? null, newValue: op.color },
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
