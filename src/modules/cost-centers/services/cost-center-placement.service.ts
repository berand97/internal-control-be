import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import { HEAD_SELECT, type HeadRow, toDto as headToDto } from '../../persons/services/cost-center-heads.service.js';
import {
  codeMatchesPrefix,
  longestPrefix,
  suggestInPrefix,
  suggestUnderParent,
} from '../domain/code-prefix.js';
import { validAt } from '../domain/placement-at.js';
import type {
  CostCenterCodeSuggestionDto,
  CostCenterHistoryDto,
  CostCenterHistoryEventDto,
  CostCenterPlacementAtDto,
  CostCenterPlacementDto,
  CostCenterPrefixMismatchDto,
  CostCenterTreeDto,
  CostCenterTreeNodeDto,
  CostCenterUnitRefDto,
  PlacementSource,
  PrefixMismatchReason,
} from '../dto/responses/cost-center-structure.responses.js';

/** Datos de la petición que van a la auditoría y al historial (patrón de auth.controller.ts: @Ip() + user-agent). */
export interface RequestMeta {
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export const NO_REQUEST: RequestMeta = { ip: null, userAgent: null };

export interface PlacementPatch {
  /** undefined: no cambia; null: la quita. */
  readonly unitId?: string | null;
  readonly parentId?: string | null;
  readonly hasMovement?: boolean;
}

export interface PlacementContext extends RequestMeta {
  readonly reason: string;
  readonly actorId: string | null;
  readonly source: Exclude<PlacementSource, 'MIGRATION'>;
  readonly stagingImportId?: string | null;
}

export interface PlacementState {
  readonly unitId: string | null;
  readonly parentId: string | null;
  readonly hasMovement: boolean;
}

export interface PlacementChange {
  readonly placementId: string;
  readonly from: PlacementState;
  readonly to: PlacementState;
  /** El centro quedó agrupador y dejó de aceptar activos. */
  readonly acceptsAssetsCleared: boolean;
}

const USER_AGENT_MAX = 500;
const BOGOTA_END_OF_DAY = 'T23:59:59.999-05:00';

interface PlacementRow {
  id: string;
  cost_center_id: string;
  has_movement: boolean;
  valid_from: Date;
  valid_until: Date | null;
  is_current: boolean;
  reason: string;
  source: PlacementSource;
  staging_import_id: string | null;
  changed_by: string | null;
  changed_at: Date;
  unit_id: string | null;
  unit_code: string | null;
  unit_name: string | null;
  unit_prefix: string | null;
  parent_id: string | null;
  parent_code: string | null;
  parent_name: string | null;
}

const PLACEMENT_SELECT = `
  SELECT p.id, p.cost_center_id, p.has_movement, p.valid_from, p.valid_until,
         (p.valid_from <= NOW() AND (p.valid_until IS NULL OR p.valid_until > NOW())) AS is_current,
         p.reason, p.source, p.staging_import_id, p.changed_by, p.changed_at,
         u.id AS unit_id, u.code AS unit_code, u.name AS unit_name, u.code_prefix AS unit_prefix,
         pc.id AS parent_id, pc.external_code AS parent_code, pc.name AS parent_name
  FROM cost_center_placement p
  LEFT JOIN organizational_unit u ON u.id = p.organizational_unit_id
  LEFT JOIN cost_center pc ON pc.id = p.parent_cost_center_id`;

const unitRef = (id: string | null, code: string | null, name: string | null, prefix: string | null): CostCenterUnitRefDto | null =>
  id ? { id, code: code ?? '', name: name ?? '', codePrefix: prefix } : null;

const toPlacementDto = (row: PlacementRow): CostCenterPlacementDto => ({
  id: row.id,
  costCenterId: row.cost_center_id,
  organizationalUnit: unitRef(row.unit_id, row.unit_code, row.unit_name, row.unit_prefix),
  parent: row.parent_id ? { id: row.parent_id, externalCode: row.parent_code ?? '', name: row.parent_name ?? '' } : null,
  hasMovement: row.has_movement,
  validFrom: row.valid_from.toISOString(),
  validUntil: row.valid_until?.toISOString() ?? null,
  isCurrent: row.is_current,
  reason: row.reason,
  source: row.source,
  stagingImportId: row.staging_import_id,
  changedBy: row.changed_by,
  changedAt: row.changed_at.toISOString(),
});

const sameState = (left: PlacementState, right: PlacementState): boolean =>
  left.unitId === right.unitId && left.parentId === right.parentId && left.hasMovement === right.hasMovement;

/**
 * Instante de una fecha AAAA-MM-DD: el final de ese día en Colombia (UTC-5, sin horario de verano), así los cambios
 * hechos ese día cuentan. Sin fecha, ahora.
 */
export const resolveAt = (date: string | undefined): Date => {
  if (!date) {
    return new Date();
  }
  const at = new Date(`${date}${BOGOTA_END_OF_DAY}`);
  if (Number.isNaN(at.getTime()) || !isCalendarDate(date)) {
    throw new ApiException(ErrorCode.ValidationFailed, 'Fecha inválida', [{ field: 'at', message: 'Use AAAA-MM-DD' }]);
  }
  return at;
};

/** Descarta fechas que el calendario corre (2026-02-31 → 3 de marzo). */
const isCalendarDate = (date: string): boolean => {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1)).toISOString().slice(0, 10) === date;
};

/**
 * Ubicación de los centros de costo en el tiempo (unidad, centro padre, movimiento). Único punto que la cambia: cierra
 * la fila vigente y abre la nueva, y actualiza la caché de cost_center (parent_id, organizational_unit_id,
 * has_movement) en la misma transacción. Nunca cambia external_code ni el nombre.
 */
@Injectable()
export class CostCenterPlacementService {
  constructor(
    private readonly dataSource: DataSource,
    @Inject('AuditLogsRepository')
    private readonly auditLogs: AuditLogsRepository,
  ) {}

  /**
   * Abre el historial de un centro recién creado en esta transacción con su estado (desde su created_at). El trigger
   * trg_cost_center_initial_placement ve la fila al hacer commit y no agrega otra.
   */
  async open(manager: EntityManager, costCenterId: string, context: PlacementContext): Promise<string> {
    const [row] = (await manager.query(
      `INSERT INTO cost_center_placement (cost_center_id, organizational_unit_id, parent_cost_center_id, has_movement,
         valid_from, reason, changed_by, ip_address, user_agent, source, staging_import_id)
       SELECT id, organizational_unit_id, parent_id, has_movement, created_at, $2, $3, $4, $5, $6, $7
       FROM cost_center WHERE id = $1
       RETURNING id`,
      [
        costCenterId,
        context.reason.trim(),
        context.actorId,
        context.ip,
        context.userAgent?.slice(0, USER_AGENT_MAX) ?? null,
        context.source,
        context.stagingImportId ?? null,
      ],
    )) as Array<{ id: string }>;
    if (!row) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'No existe el centro de costo');
    }
    return row.id;
  }

  /** open() para varios centros recién creados en esta transacción (importaciones). */
  async openMany(manager: EntityManager, costCenterIds: ReadonlyArray<string>, context: PlacementContext): Promise<number> {
    if (costCenterIds.length === 0) {
      return 0;
    }
    const rows = (await manager.query(
      `INSERT INTO cost_center_placement (cost_center_id, organizational_unit_id, parent_cost_center_id, has_movement,
         valid_from, reason, changed_by, ip_address, user_agent, source, staging_import_id)
       SELECT id, organizational_unit_id, parent_id, has_movement, created_at, $2, $3, $4, $5, $6, $7
       FROM cost_center WHERE id = ANY($1::uuid[])
       RETURNING id`,
      [
        costCenterIds,
        context.reason.trim(),
        context.actorId,
        context.ip,
        context.userAgent?.slice(0, USER_AGENT_MAX) ?? null,
        context.source,
        context.stagingImportId ?? null,
      ],
    )) as unknown[];
    return rows.length;
  }

  /**
   * Cambia la ubicación vigente. null si no cambia nada. Bloquea el centro (FOR UPDATE) para que dos cambios
   * simultáneos se serialicen; el EXCLUDE de la tabla impide solapes aunque alguien escriba por fuera.
   */
  async change(
    manager: EntityManager,
    costCenterId: string,
    patch: PlacementPatch,
    context: PlacementContext,
  ): Promise<PlacementChange | null> {
    const [center] = (await manager.query(
      `SELECT id, external_code, organizational_unit_id, parent_id, has_movement, accepts_assets
       FROM cost_center WHERE id = $1 FOR UPDATE`,
      [costCenterId],
    )) as Array<{
      id: string;
      external_code: string;
      organizational_unit_id: string | null;
      parent_id: string | null;
      has_movement: boolean;
      accepts_assets: boolean;
    }>;
    if (!center) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'No existe el centro de costo');
    }
    const from: PlacementState = {
      unitId: center.organizational_unit_id,
      parentId: center.parent_id,
      hasMovement: center.has_movement,
    };
    const to: PlacementState = {
      unitId: patch.unitId !== undefined ? patch.unitId : from.unitId,
      parentId: patch.parentId !== undefined ? patch.parentId : from.parentId,
      hasMovement: patch.hasMovement ?? from.hasMovement,
    };
    if (sameState(from, to)) {
      return null;
    }
    if (to.unitId && to.unitId !== from.unitId) {
      const [unit] = (await manager.query('SELECT is_active FROM organizational_unit WHERE id = $1', [to.unitId])) as Array<{
        is_active: boolean;
      }>;
      if (!unit) {
        throw new ApiException(ErrorCode.ResourceNotFound, 'No existe la unidad organizacional');
      }
      if (!unit.is_active) {
        throw new ApiException(ErrorCode.ValidationFailed, 'La unidad organizacional está inactiva', [
          { field: 'organizationalUnitId', message: 'Unidad inactiva' },
        ]);
      }
    }
    if (to.parentId && to.parentId !== from.parentId) {
      await this.assertNoCycle(manager, costCenterId, to.parentId);
    }
    let acceptsAssetsCleared = false;
    if (!to.hasMovement && from.hasMovement) {
      const [assets] = (await manager.query(
        `SELECT count(*)::int AS count FROM asset WHERE current_cost_center_id = $1 AND operational_status <> 'WRITTEN_OFF'`,
        [costCenterId],
      )) as Array<{ count: number }>;
      const count = assets?.count ?? 0;
      if (count > 0) {
        throw new ApiException(
          ErrorCode.CostCenterGroupingHasAssets,
          `El centro ${center.external_code} no puede quedar como agrupador: tiene ${count} activos asignados`,
          [{ field: 'activeAssets', message: String(count) }],
        );
      }
      acceptsAssetsCleared = center.accepts_assets;
    }

    const now = new Date();
    // Un cambio no puede empezar antes que la ubicación vigente (relojes, dos cambios en el mismo milisegundo).
    // UPDATE … RETURNING vuelve de manager.query como [filas, afectadas].
    const [closedRows] = (await manager.query(
      `UPDATE cost_center_placement SET valid_until = GREATEST($2::timestamptz, valid_from)
       WHERE cost_center_id = $1 AND valid_until IS NULL
       RETURNING valid_until`,
      [costCenterId, now],
    )) as [Array<{ valid_until: Date }>, number];
    const validFrom = closedRows[0]?.valid_until ?? now;
    const [created] = (await manager.query(
      `INSERT INTO cost_center_placement (cost_center_id, organizational_unit_id, parent_cost_center_id, has_movement,
         valid_from, reason, changed_by, ip_address, user_agent, source, staging_import_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        costCenterId,
        to.unitId,
        to.parentId,
        to.hasMovement,
        validFrom,
        context.reason.trim(),
        context.actorId,
        context.ip,
        context.userAgent?.slice(0, USER_AGENT_MAX) ?? null,
        context.source,
        context.stagingImportId ?? null,
      ],
    )) as Array<{ id: string }>;
    const placementId = created?.id ?? '';
    await manager.query(
      `UPDATE cost_center
       SET organizational_unit_id = $2, parent_id = $3, has_movement = $4,
           accepts_assets = CASE WHEN $5::boolean THEN FALSE ELSE accepts_assets END, updated_at = NOW()
       WHERE id = $1`,
      [costCenterId, to.unitId, to.parentId, to.hasMovement, acceptsAssetsCleared],
    );
    await this.auditLogs.record(
      {
        action: AuditAction.CostCenterPlaced,
        entityType: 'COST_CENTER',
        entityId: costCenterId,
        performedBy: context.actorId,
        ipAddress: context.ip,
        userAgent: context.userAgent?.slice(0, USER_AGENT_MAX) ?? null,
        changes: {
          event: 'COST_CENTER_PLACEMENT_CHANGED',
          placementId,
          source: context.source,
          stagingImportId: context.stagingImportId ?? null,
          from,
          to,
          acceptsAssetsCleared,
        },
      },
      manager,
    );
    return { placementId, from, to, acceptsAssetsCleared };
  }

  /** Cambio manual (POST /cost-centers/:id/placement): en su propia transacción; sin cambios es un error. */
  async changeManually(
    costCenterId: string,
    patch: PlacementPatch,
    context: PlacementContext,
  ): Promise<CostCenterPlacementDto> {
    const change = await this.dataSource.transaction((manager) => this.change(manager, costCenterId, patch, context));
    if (!change) {
      throw new ApiException(ErrorCode.CostCenterPlacementUnchanged);
    }
    const [row] = (await this.dataSource.query(`${PLACEMENT_SELECT} WHERE p.id = $1`, [change.placementId])) as PlacementRow[];
    if (!row) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'No se encontró la ubicación registrada');
    }
    return toPlacementDto(row);
  }

  async placementAt(costCenterId: string, at: Date): Promise<CostCenterPlacementAtDto> {
    await this.requireCenter(costCenterId);
    const [row] = (await this.dataSource.query(`${PLACEMENT_SELECT} WHERE p.cost_center_id = $1 AND ${validAt('$2')}`, [
      costCenterId,
      at,
    ])) as PlacementRow[];
    return { at: at.toISOString(), placement: row ? toPlacementDto(row) : null };
  }

  async history(costCenterId: string): Promise<CostCenterHistoryDto> {
    const center = await this.requireCenter(costCenterId);
    const placements = (await this.dataSource.query(`${PLACEMENT_SELECT} WHERE p.cost_center_id = $1`, [
      costCenterId,
    ])) as PlacementRow[];
    const heads = (await this.dataSource.query(`${HEAD_SELECT} WHERE h.cost_center_id = $1`, [costCenterId])) as HeadRow[];
    const events: CostCenterHistoryEventDto[] = [
      ...placements.map((row) => {
        const placement = toPlacementDto(row);
        return {
          kind: 'PLACEMENT' as const,
          validFrom: placement.validFrom,
          validUntil: placement.validUntil,
          placement,
          head: null,
        };
      }),
      ...heads.map((row) => {
        const head = headToDto(row);
        return { kind: 'HEAD' as const, validFrom: head.validFrom, validUntil: head.validUntil, placement: null, head };
      }),
    ].sort(
      (left, right) =>
        right.validFrom.localeCompare(left.validFrom) ||
        left.kind.localeCompare(right.kind) ||
        (left.placement?.id ?? left.head?.id ?? '').localeCompare(right.placement?.id ?? right.head?.id ?? ''),
    );
    return { costCenter: { id: center.id, externalCode: center.external_code, name: center.name }, events };
  }

  /** Árbol por centro padre a una fecha: unidad y movimiento de esa fecha; activos directos y estado, de hoy. */
  async tree(at: Date): Promise<CostCenterTreeDto> {
    const rows = (await this.dataSource.query(
      `SELECT cc.id, cc.external_code, cc.name, cc.is_active, p.parent_cost_center_id AS parent_id, p.has_movement,
              u.id AS unit_id, u.code AS unit_code, u.name AS unit_name, u.code_prefix AS unit_prefix,
              coalesce(a.count, 0)::int AS direct_assets
       FROM cost_center_placement p
       JOIN cost_center cc ON cc.id = p.cost_center_id
       LEFT JOIN organizational_unit u ON u.id = p.organizational_unit_id
       LEFT JOIN (SELECT current_cost_center_id, count(*) AS count FROM asset
                  WHERE operational_status <> 'WRITTEN_OFF' GROUP BY current_cost_center_id) a
         ON a.current_cost_center_id = cc.id
       WHERE ${validAt('$1')}
       ORDER BY cc.external_code`,
      [at],
    )) as Array<{
      id: string;
      external_code: string;
      name: string;
      is_active: boolean;
      parent_id: string | null;
      has_movement: boolean;
      unit_id: string | null;
      unit_code: string | null;
      unit_name: string | null;
      unit_prefix: string | null;
      direct_assets: number;
    }>;
    const heads = (await this.dataSource.query(
      `SELECT h.cost_center_id, h.person_id, trim(pe.first_name || ' ' || pe.last_name) AS person_name
       FROM cost_center_head h JOIN person pe ON pe.id = h.person_id
       WHERE h.valid_from <= $1 AND (h.valid_until IS NULL OR h.valid_until > $1)
       ORDER BY person_name, h.person_id`,
      [at],
    )) as Array<{ cost_center_id: string; person_id: string; person_name: string }>;
    const headsOf = new Map<string, Array<{ personId: string; personName: string }>>();
    for (const head of heads) {
      const list = headsOf.get(head.cost_center_id) ?? [];
      list.push({ personId: head.person_id, personName: head.person_name });
      headsOf.set(head.cost_center_id, list);
    }
    const present = new Set(rows.map((row) => row.id));
    const childrenOf = new Map<string | null, typeof rows>();
    for (const row of rows) {
      const key = row.parent_id && present.has(row.parent_id) ? row.parent_id : null;
      const list = childrenOf.get(key) ?? [];
      list.push(row);
      childrenOf.set(key, list);
    }
    const visited = new Set<string>();
    const build = (parentId: string | null): CostCenterTreeNodeDto[] =>
      (childrenOf.get(parentId) ?? [])
        .filter((row) => !visited.has(row.id))
        .map((row) => {
          visited.add(row.id);
          return {
            id: row.id,
            externalCode: row.external_code,
            name: row.name,
            isActive: row.is_active,
            hasMovement: row.has_movement,
            organizationalUnit: unitRef(row.unit_id, row.unit_code, row.unit_name, row.unit_prefix),
            directAssets: row.direct_assets,
            heads: headsOf.get(row.id) ?? [],
            children: build(row.id),
          };
        });
    return { at: at.toISOString(), roots: build(null) };
  }

  /**
   * Centros activos cuyo código no cuadra con su unidad vigente: sin unidad, unidad sin prefijo o código fuera del
   * rango (incluye los que se movieron de unidad). Nunca se corrigen: es un listado para revisar.
   */
  async prefixMismatches(): Promise<CostCenterPrefixMismatchDto[]> {
    const rows = (await this.dataSource.query(
      `SELECT cc.id, cc.external_code, cc.name,
              u.id AS unit_id, u.code AS unit_code, u.name AS unit_name, u.code_prefix AS unit_prefix
       FROM cost_center cc LEFT JOIN organizational_unit u ON u.id = cc.organizational_unit_id
       WHERE cc.is_active
       ORDER BY cc.external_code`,
    )) as Array<{
      id: string;
      external_code: string;
      name: string;
      unit_id: string | null;
      unit_code: string | null;
      unit_name: string | null;
      unit_prefix: string | null;
    }>;
    const units = (await this.dataSource.query(
      `SELECT id, code, name, code_prefix AS "codePrefix" FROM organizational_unit
       WHERE is_active AND code_prefix IS NOT NULL`,
    )) as Array<CostCenterUnitRefDto & { codePrefix: string }>;
    return rows.flatMap((row) => {
      const reason: PrefixMismatchReason | null = !row.unit_id
        ? 'NO_UNIT'
        : !row.unit_prefix
          ? 'UNIT_WITHOUT_PREFIX'
          : codeMatchesPrefix(row.external_code, row.unit_prefix)
            ? null
            : 'CODE_OUT_OF_RANGE';
      if (!reason) {
        return [];
      }
      return [
        {
          id: row.id,
          externalCode: row.external_code,
          name: row.name,
          reason,
          organizationalUnit: unitRef(row.unit_id, row.unit_code, row.unit_name, row.unit_prefix),
          expectedUnit: longestPrefix(row.external_code, units) ?? null,
        },
      ];
    });
  }

  async suggestCode(unitId: string | undefined, parentId: string | undefined): Promise<CostCenterCodeSuggestionDto> {
    const prefix = unitId ? await this.unitPrefix(unitId) : null;
    const used = new Set(
      ((await this.dataSource.query('SELECT external_code FROM cost_center')) as Array<{ external_code: string }>).map(
        (row) => row.external_code,
      ),
    );
    if (parentId) {
      const parent = await this.requireCenter(parentId);
      const suggestion = suggestUnderParent(parent.external_code, used);
      return {
        ...suggestion,
        basis: 'PARENT',
        matchesUnitPrefix: prefix && suggestion.code ? codeMatchesPrefix(suggestion.code, prefix) : null,
      };
    }
    if (!unitId) {
      throw new ApiException(ErrorCode.ValidationFailed, 'Indique la unidad o el centro padre', [
        { field: 'unitId', message: 'Requerido si no hay parentId' },
      ]);
    }
    if (!prefix) {
      throw new ApiException(ErrorCode.ValidationFailed, 'La unidad no tiene prefijo de código: indique un centro padre', [
        { field: 'unitId', message: 'Unidad sin prefijo de código' },
      ]);
    }
    return { ...suggestInPrefix(prefix, used), basis: 'UNIT', matchesUnitPrefix: true };
  }

  private async unitPrefix(unitId: string): Promise<string | null> {
    const [unit] = (await this.dataSource.query('SELECT code_prefix FROM organizational_unit WHERE id = $1', [
      unitId,
    ])) as Array<{ code_prefix: string | null }>;
    if (!unit) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'No existe la unidad organizacional');
    }
    return unit.code_prefix;
  }

  private async assertNoCycle(manager: EntityManager, costCenterId: string, parentId: string): Promise<void> {
    if (parentId === costCenterId) {
      throw new ApiException(ErrorCode.CostCenterPlacementCycle, 'Un centro no puede ser su propio padre');
    }
    const [parent] = (await manager.query('SELECT id FROM cost_center WHERE id = $1', [parentId])) as unknown[];
    if (!parent) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'No existe el centro padre');
    }
    // Ancestros del nuevo padre (tope de profundidad por si la caché ya tuviera un ciclo).
    const [cycle] = (await manager.query(
      `WITH RECURSIVE up (id, parent_id, depth) AS (
         SELECT id, parent_id, 0 FROM cost_center WHERE id = $1
         UNION ALL
         SELECT c.id, c.parent_id, up.depth + 1 FROM cost_center c JOIN up ON c.id = up.parent_id WHERE up.depth < 64
       )
       SELECT 1 AS found FROM up WHERE id = $2 LIMIT 1`,
      [parentId, costCenterId],
    )) as unknown[];
    if (cycle) {
      throw new ApiException(ErrorCode.CostCenterPlacementCycle);
    }
  }

  private async requireCenter(id: string): Promise<{ id: string; external_code: string; name: string }> {
    const [center] = (await this.dataSource.query('SELECT id, external_code, name FROM cost_center WHERE id = $1', [
      id,
    ])) as Array<{ id: string; external_code: string; name: string }>;
    if (!center) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'No existe el centro de costo');
    }
    return center;
  }
}
