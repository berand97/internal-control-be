import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { dateRangesOverlap } from '../domain/inventory-schedule.js';
import { scopeSql } from '../domain/inventory-scope-sql.js';
import type { InventoryConflictReason } from '../dto/inventory-schedule.responses.js';
import { InventoryScopeType } from '../enums/inventory-scope.js';
import { InventoryStatus } from '../enums/inventory-status.js';

/** Lo mínimo de una toma para decidir si choca con otra. */
export interface ConflictSubject {
  readonly id: string | null;
  readonly scopeType: InventoryScopeType;
  readonly scopeId: string | null;
  readonly plannedStartDate: string;
  readonly plannedEndDate: string;
}

export interface ConflictCandidate extends ConflictSubject {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: InventoryStatus;
}

export interface InventoryConflict {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: InventoryStatus;
  readonly plannedStartDate: string;
  readonly plannedEndDate: string;
  readonly reason: InventoryConflictReason;
}

interface CandidateRow {
  id: string;
  code: string;
  name: string;
  status: InventoryStatus;
  scope_type: InventoryScopeType;
  scope_id: string | null;
  start: string;
  end: string;
}

/**
 * Choques de fechas entre tomas planeadas o en curso: mismo alcance, alguna GLOBAL, o activos compartidos (misma
 * consulta que el bloqueo de inicio). Solo informa: programar advierte; el bloqueo duro está en start().
 * Dos alcances COST_CENTER distintos nunca comparten activos (un activo tiene un solo centro actual) y se descartan
 * sin consultar.
 */
@Injectable()
export class InventoryConflictsService {
  constructor(private readonly dataSource: DataSource) {}

  /** Tomas planeadas o en curso cuyo rango planeado cruza [from, to]. */
  async openCandidates(from: string, to: string, manager?: EntityManager): Promise<ConflictCandidate[]> {
    const rows = (await (manager ?? this.dataSource).query(
      `SELECT id, code, name, status, scope_type, scope_id,
              to_char(scheduled_start_date, 'YYYY-MM-DD') AS start, to_char(scheduled_end_date, 'YYYY-MM-DD') AS end
       FROM physical_inventory
       WHERE status IN ('PLANNED', 'IN_PROGRESS')
         AND scheduled_start_date <= $2::date AND scheduled_end_date >= $1::date
       ORDER BY scheduled_start_date, code`,
      [from, to],
    )) as CandidateRow[];
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      status: row.status,
      scopeType: row.scope_type,
      scopeId: row.scope_id,
      plannedStartDate: row.start,
      plannedEndDate: row.end,
    }));
  }

  /** Conflictos de `subject` con las tomas abiertas (excluida ella misma). */
  async conflictsOf(subject: ConflictSubject, manager?: EntityManager): Promise<InventoryConflict[]> {
    const candidates = await this.openCandidates(subject.plannedStartDate, subject.plannedEndDate, manager);
    return this.match(subject, candidates, manager);
  }

  async match(
    subject: ConflictSubject,
    candidates: ReadonlyArray<ConflictCandidate>,
    manager?: EntityManager,
  ): Promise<InventoryConflict[]> {
    const conflicts: InventoryConflict[] = [];
    for (const other of candidates) {
      if (other.id === subject.id) {
        continue;
      }
      if (
        !dateRangesOverlap(
          { start: subject.plannedStartDate, end: subject.plannedEndDate },
          { start: other.plannedStartDate, end: other.plannedEndDate },
        )
      ) {
        continue;
      }
      const reason = await this.reason(subject, other, manager);
      if (reason) {
        conflicts.push({
          id: other.id,
          code: other.code,
          name: other.name,
          status: other.status,
          plannedStartDate: other.plannedStartDate,
          plannedEndDate: other.plannedEndDate,
          reason,
        });
      }
    }
    return conflicts;
  }

  private async reason(
    left: ConflictSubject,
    right: ConflictSubject,
    manager?: EntityManager,
  ): Promise<InventoryConflictReason | null> {
    if (left.scopeType === InventoryScopeType.Global || right.scopeType === InventoryScopeType.Global) {
      return 'GLOBAL_SCOPE';
    }
    if (left.scopeType === right.scopeType && left.scopeId === right.scopeId) {
      return 'SAME_SCOPE';
    }
    if (left.scopeType === InventoryScopeType.CostCenter && right.scopeType === InventoryScopeType.CostCenter) {
      return null;
    }
    const leftSql = scopeSql('a', left.scopeType, left.scopeId, 1);
    const rightSql = scopeSql('a', right.scopeType, right.scopeId, 1 + leftSql.params.length);
    const [row] = (await (manager ?? this.dataSource).query(
      `SELECT EXISTS (
         SELECT 1 FROM asset a
         WHERE a.operational_status <> 'WRITTEN_OFF' AND (${leftSql.sql}) AND (${rightSql.sql})
       ) AS overlap`,
      [...leftSql.params, ...rightSql.params],
    )) as Array<{ overlap: boolean }>;
    return row?.overlap === true ? 'SHARED_ASSETS' : null;
  }
}
