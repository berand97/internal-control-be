import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import { findFormat } from '../../documents/domain/document-formats.js';
import {
  costCenterFilter,
  type ReadableCostCenterScope,
} from '../../roles/services/cost-center-scope.js';
import type {
  AssetTimelineEventDto,
  AssetTimelineResponseDto,
  TimelineDatePrecision,
  TimelineEventKind,
} from '../dto/responses/asset-timeline.response.dto.js';

const MOVEMENT_LABELS: Record<string, string> = {
  REGISTRATION: 'Registro',
  ASSIGNMENT: 'Asignación',
  LOAN: 'Préstamo',
  RETURN: 'Devolución',
  TRANSFER: 'Traslado de centro de costo',
  RELOCATION: 'Reubicación',
  MAINTENANCE_IN: 'Entrada a mantenimiento',
  MAINTENANCE_OUT: 'Salida de mantenimiento',
  PHYSICAL_VERIFICATION: 'Verificación en toma física',
  CONDITION_CHANGE: 'Cambio de estado físico',
  WRITE_OFF: 'Baja',
  REACTIVATION: 'Reactivación',
  QR_ROTATION: 'Rotación de QR',
  CORRECTION: 'Corrección',
};

const INVENTORY_LABELS: Record<string, string> = {
  FOUND: 'encontrado',
  MISSING: 'faltante',
  SURPLUS: 'sobrante',
  MISPLACED: 'en otra ubicación',
  PENDING: 'pendiente de verificar',
};

interface EventRow {
  kind: TimelineEventKind;
  type: string;
  source_id: string;
  occurred_at: Date;
  date_precision: TimelineDatePrecision;
  actor_id: string | null;
  actor_name: string | null;
  document_id: string | null;
  document_number: string | null;
  document_format: string | null;
  document_status: string | null;
  details: Record<string, unknown>;
}

const EVENTS_SQL = `
  WITH events AS (
    SELECT 'ASSET' AS kind, 'ACQUISITION' AS type, a.id::text AS source_id,
           a.acquisition_date::timestamp AT TIME ZONE 'UTC' AS occurred_at, 'DAY' AS date_precision, 0 AS rank,
           NULL::uuid AS actor_id, NULL::uuid AS document_id,
           jsonb_build_object('acquisitionDocument', a.acquisition_document,
             'acquisitionPrice', a.acquisition_price, 'currency', a.currency) AS details
    FROM asset a
    WHERE a.id = $1 AND a.acquisition_date IS NOT NULL
    UNION ALL
    SELECT 'MOVEMENT', m.movement_type::text, m.id::text, m.executed_at,
           CASE WHEN m.metadata->>'source' = 'EXCEL_IMPORT' THEN
             CASE WHEN (m.metadata->>'executedAtKnown')::boolean THEN 'DAY' ELSE 'UNKNOWN' END
           ELSE 'INSTANT' END,
           1, m.requested_by, da.document_id,
           jsonb_build_object(
             'reason', m.reason,
             'documentReference', m.document_reference,
             'source', m.metadata->>'source',
             'fromOperationalStatus', m.from_operational_status,
             'toOperationalStatus', m.to_operational_status,
             'fromPhysicalCondition', m.from_physical_condition,
             'toPhysicalCondition', m.to_physical_condition,
             'fromCostCenter', CASE WHEN fcc.id IS NULL THEN NULL
               ELSE jsonb_build_object('id', fcc.id, 'code', fcc.external_code, 'name', fcc.name) END,
             'toCostCenter', CASE WHEN tcc.id IS NULL THEN NULL
               ELSE jsonb_build_object('id', tcc.id, 'code', tcc.external_code, 'name', tcc.name) END,
             'fromLocation', CASE WHEN fl.id IS NULL THEN NULL
               ELSE jsonb_build_object('id', fl.id, 'code', fl.code, 'name', fl.name) END,
             'toLocation', CASE WHEN tl.id IS NULL THEN NULL
               ELSE jsonb_build_object('id', tl.id, 'code', tl.code, 'name', tl.name) END,
             'loanId', m.loan_id,
             'inventoryId', m.metadata->>'inventoryId',
             'result', m.metadata->>'result')
    FROM asset_movement m
    LEFT JOIN document_asset da ON da.movement_id = m.id
    LEFT JOIN cost_center fcc ON fcc.id = m.from_cost_center_id
    LEFT JOIN cost_center tcc ON tcc.id = m.to_cost_center_id
    LEFT JOIN location fl ON fl.id = m.from_location_id
    LEFT JOIN location tl ON tl.id = m.to_location_id
    WHERE m.asset_id = $1
    UNION ALL
    SELECT 'DOCUMENT', d.format_key, d.id::text, d.created_at, 'INSTANT', 2, d.created_by, d.id,
           jsonb_build_object('signedAt', d.signed_at)
    FROM document_asset da
    JOIN document d ON d.id = da.document_id
    WHERE da.asset_id = $1 AND da.movement_id IS NULL
    UNION ALL
    SELECT 'PHOTO', CASE WHEN p.is_primary THEN 'PRIMARY_PHOTO' ELSE 'PHOTO' END, p.id::text, p.uploaded_at,
           'INSTANT', 3, p.uploaded_by, NULL, jsonb_build_object('caption', p.caption)
    FROM asset_photo p
    WHERE p.asset_id = $1
    UNION ALL
    SELECT 'INVENTORY', i.verification_result, i.id::text,
           coalesce(i.verified_at, pi.actual_end_date::timestamp AT TIME ZONE 'UTC',
                    pi.actual_start_date::timestamp AT TIME ZONE 'UTC', pi.created_at),
           CASE WHEN i.verified_at IS NULL THEN 'DAY' ELSE 'INSTANT' END,
           4, i.verified_by, NULL,
           jsonb_build_object('inventoryId', pi.id, 'inventoryCode', pi.code, 'inventoryName', pi.name,
             'inventoryStatus', pi.status, 'actualCondition', i.actual_condition, 'notes', i.notes)
    FROM physical_inventory_item i
    JOIN physical_inventory pi ON pi.id = i.inventory_id
    WHERE i.asset_id = $1
      AND NOT EXISTS (
        SELECT 1 FROM asset_movement m
        WHERE m.asset_id = i.asset_id
          AND m.movement_type = 'PHYSICAL_VERIFICATION'
          AND m.metadata->>'inventoryId' = pi.id::text
      )
  )
`;

@Injectable()
export class AssetTimelineService {
  constructor(private readonly dataSource: DataSource) {}

  async timeline(
    assetId: string,
    options: { readonly page: number; readonly pageSize: number; readonly order: 'asc' | 'desc' },
    scope: ReadableCostCenterScope,
  ): Promise<AssetTimelineResponseDto> {
    // Fuera de alcance responde igual que inexistente.
    const [asset] = (await this.dataSource.query(
      'SELECT id FROM asset WHERE id = $1 AND ($2::uuid[] IS NULL OR current_cost_center_id = ANY($2::uuid[]))',
      [assetId, costCenterFilter(scope)],
    )) as Array<{
      id: string;
    }>;
    if (!asset) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    const direction = options.order === 'desc' ? 'DESC' : 'ASC';
    const [counted] = (await this.dataSource.query(`${EVENTS_SQL} SELECT count(*)::int AS total FROM events`, [
      assetId,
    ])) as Array<{ total: number }>;
    const rows = (await this.dataSource.query(
      `${EVENTS_SQL}
       SELECT e.kind, e.type, e.source_id, e.occurred_at, e.date_precision, e.actor_id, e.details,
              nullif(trim(concat_ws(' ', p.first_name, p.last_name)), '') AS actor_name,
              d.id AS document_id, d.number AS document_number, d.format_key AS document_format,
              d.status AS document_status
       FROM events e
       LEFT JOIN app_user u ON u.id = e.actor_id
       LEFT JOIN person p ON p.id = u.person_id
       LEFT JOIN document d ON d.id = e.document_id
       ORDER BY e.occurred_at ${direction}, e.rank ${direction}, e.source_id ${direction}
       LIMIT $2 OFFSET $3`,
      [assetId, options.pageSize, (options.page - 1) * options.pageSize],
    )) as EventRow[];
    const total = counted?.total ?? 0;
    return {
      assetId,
      items: rows.map((row) => this.toEvent(row)),
      page: options.page,
      pageSize: options.pageSize,
      total,
      hasNext: options.page * options.pageSize < total,
    };
  }

  private toEvent(row: EventRow): AssetTimelineEventDto {
    return {
      id: `${row.kind.toLowerCase()}:${row.source_id}`,
      kind: row.kind,
      type: row.type,
      occurredAt: new Date(row.occurred_at).toISOString(),
      datePrecision: row.date_precision,
      actor: row.actor_id ? { userId: row.actor_id, name: row.actor_name } : null,
      summary: this.summary(row),
      documentId: row.document_id,
      document: row.document_id
        ? {
            id: row.document_id,
            formatKey: row.document_format ?? '',
            number: row.document_number ?? '',
            status: row.document_status ?? '',
          }
        : null,
      details: row.details,
    };
  }

  private summary(row: EventRow): string {
    const details = row.details;
    const text = (key: string): string | null => {
      const value = details[key];
      return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
    };
    const place = (key: string): string | null => {
      const value = details[key] as { code?: string; name?: string } | null | undefined;
      return value ? [value.code, value.name].filter(Boolean).join(' ') : null;
    };
    switch (row.kind) {
      case 'ASSET':
        return text('acquisitionDocument') ? `Compra (${text('acquisitionDocument')})` : 'Compra';
      case 'MOVEMENT': {
        const label = MOVEMENT_LABELS[row.type] ?? row.type;
        if (row.type === 'REGISTRATION' && text('source') === 'EXCEL_IMPORT') {
          return row.date_precision === 'UNKNOWN'
            ? 'Registro por importación del inventario en Excel (sin fecha de compra)'
            : 'Registro por importación del inventario en Excel';
        }
        if (row.type === 'TRANSFER' && (place('fromCostCenter') || place('toCostCenter'))) {
          return `${label}: ${place('fromCostCenter') ?? '—'} → ${place('toCostCenter') ?? '—'}`;
        }
        if (row.type === 'RELOCATION' && (place('fromLocation') || place('toLocation'))) {
          return `${label}: ${place('fromLocation') ?? '—'} → ${place('toLocation') ?? '—'}`;
        }
        if (row.type === 'PHYSICAL_VERIFICATION' && text('result')) {
          return `${label} (${INVENTORY_LABELS[text('result') ?? ''] ?? text('result')})`;
        }
        return text('reason') ? `${label}: ${text('reason')}` : label;
      }
      case 'DOCUMENT': {
        const format = findFormat(row.type);
        return `${format?.name ?? row.type} ${row.document_number ?? ''}`.trim();
      }
      case 'PHOTO':
        return row.type === 'PRIMARY_PHOTO' ? 'Foto principal' : text('caption') ? `Foto: ${text('caption')}` : 'Foto';
      case 'INVENTORY':
        return `Incluido en la toma física ${text('inventoryCode') ?? ''}: ${INVENTORY_LABELS[row.type] ?? row.type}`.trim();
      default:
        return row.type;
    }
  }
}
