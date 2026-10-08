import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { userDisplayNameSubquery } from '../../persons/services/cost-center-heads.service.js';

/**
 * Historial de NOMBRE y CÓDIGO de centros y de NOMBRE/TIPO/PADRE/PREFIJO/LÍNEA/CENTRO PROPIO/ESTADO de unidades
 * (tabla org_structure_history, un evento por campo cambiado). La ubicación de los centros sigue en
 * cost_center_placement. Valores legibles (códigos y nombres de la estructura), nunca datos personales.
 */

export const ORG_HISTORY_ENTITIES = ['ORG_UNIT', 'COST_CENTER'] as const;
export type OrgHistoryEntity = (typeof ORG_HISTORY_ENTITIES)[number];

export const ORG_HISTORY_FIELDS = [
  'NAME',
  'CODE',
  'TYPE',
  'PARENT',
  'PREFIX',
  'RELATION',
  'HEAD_COST_CENTER',
  'STATUS',
] as const;
export type OrgHistoryField = (typeof ORG_HISTORY_FIELDS)[number];

/** AUTO: el conciliador de estructura (amarre del centro propio). */
export const ORG_HISTORY_SOURCES = ['MANUAL', 'IMPORT', 'AUTO'] as const;
export type OrgHistorySource = (typeof ORG_HISTORY_SOURCES)[number];

export interface OrgHistoryEntry {
  readonly entityType: OrgHistoryEntity;
  readonly entityId: string;
  readonly field: OrgHistoryField;
  readonly oldValue: string | null;
  readonly newValue: string | null;
}

export interface OrgHistoryContext {
  readonly actorId: string | null;
  readonly source: OrgHistorySource;
  readonly reason?: string | null;
}

export interface OrgHistoryEvent {
  readonly id: string;
  readonly field: OrgHistoryField;
  readonly oldValue: string | null;
  readonly newValue: string | null;
  readonly changedAt: string;
  readonly changedBy: string | null;
  readonly changedByName: string | null;
  readonly source: OrgHistorySource;
  readonly reason: string | null;
}

@Injectable()
export class OrgStructureHistoryService {
  constructor(private readonly dataSource: DataSource) {}

  async record(
    manager: EntityManager,
    entries: ReadonlyArray<OrgHistoryEntry>,
    context: OrgHistoryContext,
  ): Promise<number> {
    const changed = entries.filter((entry) => entry.oldValue !== entry.newValue);
    if (changed.length === 0) {
      return 0;
    }
    await manager.query(
      `INSERT INTO org_structure_history (entity_type, entity_id, field, old_value, new_value, changed_by, source, reason)
       SELECT t.entity_type, t.entity_id, t.field, t.old_value, t.new_value, $6, $7, $8
       FROM unnest($1::text[], $2::uuid[], $3::text[], $4::text[], $5::text[])
         AS t(entity_type, entity_id, field, old_value, new_value)`,
      [
        changed.map((entry) => entry.entityType),
        changed.map((entry) => entry.entityId),
        changed.map((entry) => entry.field),
        changed.map((entry) => entry.oldValue),
        changed.map((entry) => entry.newValue),
        context.actorId,
        context.source,
        context.reason ?? null,
      ],
    );
    return changed.length;
  }

  async list(entityType: OrgHistoryEntity, entityId: string): Promise<OrgHistoryEvent[]> {
    const rows = (await this.dataSource.query(
      `SELECT h.id, h.field, h.old_value, h.new_value, h.changed_at, h.changed_by,
              ${userDisplayNameSubquery('h.changed_by')} AS changed_by_name, h.source, h.reason
       FROM org_structure_history h
       WHERE h.entity_type = $1 AND h.entity_id = $2
       ORDER BY h.changed_at DESC, h.id`,
      [entityType, entityId],
    )) as Array<{
      id: string;
      field: OrgHistoryField;
      old_value: string | null;
      new_value: string | null;
      changed_at: Date;
      changed_by: string | null;
      changed_by_name: string | null;
      source: OrgHistorySource;
      reason: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      field: row.field,
      oldValue: row.old_value,
      newValue: row.new_value,
      changedAt: row.changed_at.toISOString(),
      changedBy: row.changed_by,
      changedByName: row.changed_by_name,
      source: row.source,
      reason: row.reason,
    }));
  }
}
