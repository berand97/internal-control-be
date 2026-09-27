import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AppConfig } from '../../../config/configuration.js';
import {
  MAX_CALENDAR_DAYS,
  bogotaDate,
  compareCoverage,
  daysBetween,
  notFoundRate,
  weekConcentration,
} from '../domain/inventory-schedule.js';
import { scopeSql } from '../domain/inventory-scope-sql.js';
import type { InventoryCalendarQueryDto } from '../dto/inventory.dto.js';
import { InventoryScopeType } from '../enums/inventory-scope.js';
import { InventoryStatus } from '../enums/inventory-status.js';
import { InventoryConflictsService, type InventoryConflict } from './inventory-conflicts.service.js';

interface CalendarRow {
  id: string;
  code: string;
  name: string;
  status: InventoryStatus;
  scope_type: InventoryScopeType;
  scope_id: string | null;
  start: string;
  end: string;
  reschedule_count: number;
  responsible_user_id: string;
  responsible_name: string | null;
  cc_id: string | null;
  cc_code: string | null;
  cc_name: string | null;
  target_code: string | null;
  target_name: string | null;
}

interface CoverageRow {
  id: string;
  code: string;
  name: string;
  assets: number;
  inventory_id: string | null;
  inventory_code: string | null;
  closed_at: Date | null;
  closed_day: string | null;
  inventory_status: InventoryStatus.Closed | InventoryStatus.Reconciled | null;
  scope_type: InventoryScopeType | null;
  expected: number | null;
  not_found: number | null;
  misplaced: number | null;
  unexpected: number | null;
}

interface PlannedRow {
  id: string;
  code: string;
  scope_type: InventoryScopeType;
  scope_id: string | null;
  start: string;
  end: string;
}

const OPEN: ReadonlyArray<InventoryStatus> = [InventoryStatus.Planned, InventoryStatus.InProgress];

/** Calendario de tomas y cobertura por centro de costo (solo lectura). */
@Injectable()
export class InventoryPlanningService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly conflicts: InventoryConflictsService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async calendar(query: InventoryCalendarQueryDto) {
    const { from, to } = query;
    if (to < from) {
      throw new ApiException(ErrorCode.ValidationFailed, 'La fecha final de la ventana es anterior a la inicial', [
        { field: 'to', message: 'Debe ser igual o posterior a from' },
      ]);
    }
    if (daysBetween(from, to) + 1 > MAX_CALENDAR_DAYS) {
      throw new ApiException(ErrorCode.ValidationFailed, `La ventana no puede superar ${MAX_CALENDAR_DAYS} días`, [
        { field: 'to', message: `Máximo ${MAX_CALENDAR_DAYS} días entre from y to` },
      ]);
    }
    const rows = (await this.dataSource.query(
      `SELECT i.id, i.code, i.name, i.status, i.scope_type, i.scope_id, i.reschedule_count, i.responsible_user_id,
              to_char(i.scheduled_start_date, 'YYYY-MM-DD') AS start, to_char(i.scheduled_end_date, 'YYYY-MM-DD') AS end,
              nullif(trim(concat_ws(' ', p.first_name, p.last_name)), '') AS responsible_name,
              cc.id AS cc_id, cc.external_code AS cc_code, cc.name AS cc_name,
              coalesce(l.code, ou.code) AS target_code, coalesce(l.name, ou.name) AS target_name
       FROM physical_inventory i
       LEFT JOIN app_user u ON u.id = i.responsible_user_id
       LEFT JOIN person p ON p.id = u.person_id
       LEFT JOIN cost_center cc ON i.scope_type = 'COST_CENTER' AND cc.id = i.scope_id
       LEFT JOIN location l ON i.scope_type = 'LOCATION' AND l.id = i.scope_id
       LEFT JOIN organizational_unit ou ON i.scope_type = 'ORG_UNIT' AND ou.id = i.scope_id
       WHERE i.scheduled_start_date <= $2::date AND i.scheduled_end_date >= $1::date
         AND ($3::boolean OR i.status <> 'CANCELLED')
       ORDER BY i.scheduled_start_date, i.code`,
      [from, to, query.includeCancelled === true],
    )) as CalendarRow[];

    const open = rows.filter((row) => OPEN.includes(row.status));
    const minStart = open.reduce((min, row) => (row.start < min ? row.start : min), from);
    const maxEnd = open.reduce((max, row) => (row.end > max ? row.end : max), to);
    const candidates = open.length > 0 ? await this.conflicts.openCandidates(minStart, maxEnd) : [];

    const items = [];
    for (const row of rows) {
      const conflicts: InventoryConflict[] = OPEN.includes(row.status)
        ? await this.conflicts.match(
            {
              id: row.id,
              scopeType: row.scope_type,
              scopeId: row.scope_id,
              plannedStartDate: row.start,
              plannedEndDate: row.end,
            },
            candidates,
          )
        : [];
      items.push({
        id: row.id,
        code: row.code,
        name: row.name,
        status: row.status,
        scope: row.scope_type,
        scopeLabel: scopeLabel(row),
        costCenter: row.cc_id ? { id: row.cc_id, code: row.cc_code ?? '', name: row.cc_name ?? '' } : null,
        plannedStartDate: row.start,
        plannedEndDate: row.end,
        rescheduled: Number(row.reschedule_count) > 0,
        rescheduleCount: Number(row.reschedule_count),
        responsible: { id: row.responsible_user_id, name: row.responsible_name },
        conflicts,
      });
    }

    const threshold = this.config.get('inventories', { infer: true })?.weeklyConcentrationThreshold ?? null;
    const counted = rows
      .filter((row) => row.status !== InventoryStatus.Cancelled)
      .map((row) => ({ id: row.id, start: row.start, end: row.end }));
    const weekWarnings = weekConcentration(counted, from, to, threshold).map((load) => ({
      isoWeek: load.week.key,
      weekStart: load.week.start,
      weekEnd: load.week.end,
      count: load.inventoryIds.length,
      threshold: threshold ?? 0,
      inventoryIds: [...load.inventoryIds],
    }));
    return { from, to, weeklyThreshold: threshold, items, weekWarnings };
  }

  /**
   * Cobertura por centro de costo con activos actuales (asset.current_cost_center_id, sin WRITTEN_OFF). La última
   * toma de un centro es la toma CLOSED/RECONCILED más reciente (closed_at) con ítems esperados de ese centro
   * (physical_inventory_item.expected_cost_center_id), sea cual sea su alcance.
   */
  async coverage() {
    const today = bogotaDate(new Date());
    const rows = (await this.dataSource.query(
      `WITH centers AS (
         SELECT a.current_cost_center_id AS id, count(*)::int AS assets
         FROM asset a
         WHERE a.operational_status <> 'WRITTEN_OFF' AND a.current_cost_center_id IS NOT NULL
         GROUP BY a.current_cost_center_id
       ),
       last AS (
         SELECT DISTINCT ON (it.expected_cost_center_id)
                it.expected_cost_center_id AS cost_center_id, pi.id, pi.code, pi.closed_at, pi.status,
                pi.scope_type, pi.scope_id
         FROM physical_inventory_item it
         JOIN physical_inventory pi ON pi.id = it.inventory_id
         WHERE pi.status IN ('CLOSED', 'RECONCILED') AND pi.closed_at IS NOT NULL
           AND it.expected_cost_center_id IS NOT NULL
         ORDER BY it.expected_cost_center_id, pi.closed_at DESC, pi.id
       )
       SELECT c.id, cc.external_code AS code, cc.name, c.assets,
              l.id AS inventory_id, l.code AS inventory_code, l.closed_at, l.status AS inventory_status,
              l.scope_type,
              to_char((l.closed_at AT TIME ZONE 'America/Bogota')::date, 'YYYY-MM-DD') AS closed_day,
              r.expected, r.not_found, r.misplaced,
              CASE WHEN l.scope_type = 'COST_CENTER' AND l.scope_id = c.id THEN r.unexpected END AS unexpected
       FROM centers c
       JOIN cost_center cc ON cc.id = c.id
       LEFT JOIN last l ON l.cost_center_id = c.id
       LEFT JOIN LATERAL (
         SELECT count(*) FILTER (WHERE x.expected_cost_center_id = c.id AND x.verification_result <> 'SURPLUS')::int AS expected,
                count(*) FILTER (WHERE x.expected_cost_center_id = c.id AND x.verification_result = 'MISSING')::int AS not_found,
                count(*) FILTER (WHERE x.expected_cost_center_id = c.id AND x.verification_result = 'MISPLACED')::int AS misplaced,
                count(*) FILTER (WHERE x.verification_result = 'SURPLUS')::int AS unexpected
         FROM physical_inventory_item x WHERE x.inventory_id = l.id
       ) r ON l.id IS NOT NULL`,
    )) as CoverageRow[];

    const next = await this.nextScheduledByCenter(today, rows.map((row) => row.id));

    const items = rows
      .map((row) => {
        const lastResult =
          row.inventory_id === null
            ? null
            : {
                expected: Number(row.expected ?? 0),
                notFound: Number(row.not_found ?? 0),
                misplaced: Number(row.misplaced ?? 0),
                unexpected: row.unexpected === null ? null : Number(row.unexpected),
              };
        return {
          costCenter: { id: row.id, code: row.code, name: row.name },
          activeAssets: Number(row.assets),
          lastInventory:
            row.inventory_id === null || row.closed_at === null || row.inventory_status === null
              ? null
              : {
                  id: row.inventory_id,
                  code: row.inventory_code ?? '',
                  closedAt: row.closed_at,
                  status: row.inventory_status,
                  scope: row.scope_type ?? InventoryScopeType.CostCenter,
                },
          lastResult,
          notFoundRate: lastResult ? notFoundRate(lastResult) : null,
          daysSinceLast: row.closed_day ? daysBetween(row.closed_day, today) : null,
          nextScheduled: next.get(row.id) ?? null,
        };
      })
      .sort((left, right) =>
        compareCoverage(
          {
            code: left.costCenter.code,
            daysSinceLast: left.daysSinceLast,
            expected: left.lastResult?.expected ?? null,
            notFound: left.lastResult?.notFound ?? null,
          },
          {
            code: right.costCenter.code,
            daysSinceLast: right.daysSinceLast,
            expected: right.lastResult?.expected ?? null,
            notFound: right.lastResult?.notFound ?? null,
          },
        ),
      );
    return {
      today,
      costCenters: items.length,
      neverInventoried: items.filter((item) => item.lastInventory === null).length,
      items,
    };
  }

  /** Próxima toma PLANNED con inicio desde hoy que cubre cada centro (por alcance directo o por sus activos). */
  private async nextScheduledByCenter(today: string, centerIds: ReadonlyArray<string>) {
    const planned = (await this.dataSource.query(
      `SELECT id, code, scope_type, scope_id,
              to_char(scheduled_start_date, 'YYYY-MM-DD') AS start, to_char(scheduled_end_date, 'YYYY-MM-DD') AS end
       FROM physical_inventory
       WHERE status = 'PLANNED' AND scheduled_start_date >= $1::date
       ORDER BY scheduled_start_date, code`,
      [today],
    )) as PlannedRow[];
    const next = new Map<
      string,
      { id: string; code: string; plannedStartDate: string; plannedEndDate: string; scope: InventoryScopeType }
    >();
    for (const inventory of planned) {
      const covered = await this.centersOf(inventory, centerIds);
      for (const centerId of covered) {
        if (!next.has(centerId)) {
          next.set(centerId, {
            id: inventory.id,
            code: inventory.code,
            plannedStartDate: inventory.start,
            plannedEndDate: inventory.end,
            scope: inventory.scope_type,
          });
        }
      }
    }
    return next;
  }

  private async centersOf(inventory: PlannedRow, centerIds: ReadonlyArray<string>): Promise<ReadonlyArray<string>> {
    if (inventory.scope_type === InventoryScopeType.Global) {
      return centerIds;
    }
    if (inventory.scope_type === InventoryScopeType.CostCenter) {
      return inventory.scope_id ? [inventory.scope_id] : [];
    }
    const scoped = scopeSql('a', inventory.scope_type, inventory.scope_id, 1);
    const rows = (await this.dataSource.query(
      `SELECT DISTINCT a.current_cost_center_id AS id FROM asset a
       WHERE a.operational_status <> 'WRITTEN_OFF' AND (${scoped.sql})`,
      [...scoped.params],
    )) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }
}

const scopeLabel = (row: CalendarRow): string => {
  switch (row.scope_type) {
    case InventoryScopeType.Global:
      return 'Toda la institución';
    case InventoryScopeType.CostCenter:
      return row.cc_code ? `Centro de costo ${row.cc_code} · ${row.cc_name ?? ''}` : 'Centro de costo';
    case InventoryScopeType.Location:
      return row.target_code ? `Ubicación ${row.target_code} · ${row.target_name ?? ''}` : 'Ubicación';
    case InventoryScopeType.OrgUnit:
      return row.target_code ? `Unidad ${row.target_code} · ${row.target_name ?? ''}` : 'Unidad';
  }
};
