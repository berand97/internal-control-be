import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import { PermissionsService } from '../../roles/services/permissions.service.js';
import { DOCUMENT_FORMATS, findFormat } from '../domain/document-formats.js';

export const DOCUMENT_LIST_STATUSES = [
  'PENDING_GENERATION',
  'FAILED',
  'PENDING_SIGNATURE',
  'SIGNED',
  'REJECTED',
] as const;
export type DocumentListStatus = (typeof DOCUMENT_LIST_STATUSES)[number];

export const MAX_AUTOMATIC_ATTEMPTS = 5;

export interface DocumentListQuery {
  readonly id?: string;
  readonly formatKey?: string;
  readonly status?: DocumentListStatus;
  readonly from?: string;
  readonly to?: string;
  readonly page: number;
  readonly pageSize: number;
}

export interface DocumentListItem {
  readonly id: string;
  readonly documentId: string | null;
  readonly requestId: string | null;
  readonly formatKey: string;
  readonly sgcCode: string;
  readonly formatName: string;
  readonly number: string | null;
  readonly status: DocumentListStatus;
  readonly createdAt: string;
  readonly requestedBy: { readonly userId: string; readonly name: string | null } | null;
  readonly asset: { readonly id: string; readonly code: string; readonly description: string } | null;
  readonly assetCount: number;
  readonly error: string | null;
  readonly attempts: number | null;
  readonly retriesAutomatically: boolean;
  readonly retryable: boolean;
}

interface Row {
  id: string;
  document_id: string | null;
  request_id: string | null;
  format_key: string;
  number: string | null;
  status: DocumentListStatus;
  created_at: Date;
  requested_by: string | null;
  requested_by_name: string | null;
  error: string | null;
  attempts: number | null;
  asset_count: number;
  asset_id: string | null;
  asset_code: string | null;
  asset_description: string | null;
}

const ITEMS_SQL = `
  WITH items AS (
    SELECT d.id, d.id AS document_id, r.id AS request_id, d.format_key, d.number, d.status, d.created_at,
           coalesce(r.requested_by, d.created_by) AS requested_by, NULL::text AS error, r.attempts,
           (SELECT count(*)::int FROM document_asset da WHERE da.document_id = d.id) AS asset_count,
           (SELECT min(da.asset_id::text) FROM document_asset da WHERE da.document_id = d.id) AS first_asset
    FROM document d
    LEFT JOIN document_request r ON r.document_id = d.id
    UNION ALL
    SELECT r.id, NULL, r.id, r.format_key, NULL,
           CASE WHEN r.status = 'FAILED' THEN 'FAILED' ELSE 'PENDING_GENERATION' END,
           r.created_at, r.requested_by, r.last_error, r.attempts,
           CASE WHEN jsonb_typeof(r.payload->'assetIds') = 'array' THEN jsonb_array_length(r.payload->'assetIds') ELSE 0 END,
           r.payload->'assetIds'->>0
    FROM document_request r
    WHERE r.document_id IS NULL
  ),
  filtered AS (
    SELECT * FROM items
    WHERE format_key = ANY($1::text[])
      AND ($2::text IS NULL OR status = $2)
      AND ($3::date IS NULL OR created_at >= $3::date)
      AND ($4::date IS NULL OR created_at < $4::date + 1)
      AND ($5::uuid IS NULL OR id = $5)
  )
`;

@Injectable()
export class DocumentListService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly permissions: PermissionsService,
  ) {}

  async list(query: DocumentListQuery, actorId: string) {
    const readable = await this.readableFormats(actorId);
    if (query.formatKey && !findFormat(query.formatKey)) {
      throw new ApiException(ErrorCode.ValidationFailed, `Formato desconocido: ${query.formatKey}`);
    }
    if (query.formatKey && !readable.includes(query.formatKey)) {
      throw new ApiException(ErrorCode.InsufficientPermissions, `Sin permiso de lectura sobre ${query.formatKey}`);
    }
    if (readable.length === 0) {
      throw new ApiException(ErrorCode.InsufficientPermissions, 'Sin permiso de lectura sobre ningún formato');
    }
    const params = [
      query.formatKey ? [query.formatKey] : readable,
      query.status ?? null,
      query.from ?? null,
      query.to ?? null,
      query.id ?? null,
    ];
    const [counted] = (await this.dataSource.query(`${ITEMS_SQL} SELECT count(*)::int AS total FROM filtered`, params)) as Array<{
      total: number;
    }>;
    const rows = (await this.dataSource.query(
      `${ITEMS_SQL}
       SELECT f.id, f.document_id, f.request_id, f.format_key, f.number, f.status, f.created_at, f.requested_by,
              nullif(trim(concat_ws(' ', p.first_name, p.last_name)), '') AS requested_by_name,
              f.error, f.attempts, f.asset_count,
              a.id AS asset_id,
              coalesce(
                (SELECT value FROM asset_identifier i WHERE i.asset_id = a.id AND i.identifier_type = 'VISIBLE_CODE' AND i.valid_to IS NULL LIMIT 1),
                (SELECT value FROM asset_identifier i WHERE i.asset_id = a.id AND i.identifier_type = 'LEGACY_CODE' AND i.valid_to IS NULL ORDER BY i.created_at LIMIT 1),
                a.internal_code) AS asset_code,
              a.description AS asset_description
       FROM filtered f
       LEFT JOIN app_user u ON u.id = f.requested_by
       LEFT JOIN person p ON p.id = u.person_id
       LEFT JOIN asset a ON f.asset_count = 1 AND a.id::text = f.first_asset
       ORDER BY f.created_at DESC, f.id DESC
       LIMIT $6 OFFSET $7`,
      [...params, query.pageSize, (query.page - 1) * query.pageSize],
    )) as Row[];
    const total = counted?.total ?? 0;
    return {
      items: rows.map((row) => this.toItem(row)),
      page: query.page,
      pageSize: query.pageSize,
      total,
      hasNext: query.page * query.pageSize < total,
    };
  }

  async retry(requestId: string, actorId: string): Promise<DocumentListItem> {
    const [request] = (await this.dataSource.query(
      'SELECT format_key, status, document_id FROM document_request WHERE id = $1',
      [requestId],
    )) as Array<{ format_key: string; status: string; document_id: string | null }>;
    const format = request ? findFormat(request.format_key) : undefined;
    if (!request || !format) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'No existe la solicitud de documento');
    }
    if (!(await this.permissions.userHasPermission(actorId, format.generatePermission))) {
      throw new ApiException(ErrorCode.InsufficientPermissions, `Requiere permiso ${format.generatePermission}`);
    }
    const updated = (await this.dataSource.query(
      `WITH updated AS (
         UPDATE document_request SET status = 'PENDING'
         WHERE id = $1 AND status = 'FAILED' AND document_id IS NULL RETURNING id
       ) SELECT id FROM updated`,
      [requestId],
    )) as Array<{ id: string }>;
    if (updated.length === 0) {
      throw new ApiException(ErrorCode.InvalidState, 'Solo se reintenta una solicitud fallida');
    }
    const [item] = (await this.list({ id: requestId, formatKey: format.key, page: 1, pageSize: 1 }, actorId)).items;
    if (!item) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'No existe la solicitud de documento');
    }
    return item;
  }

  private async readableFormats(actorId: string): Promise<string[]> {
    const byPermission = new Map<string, boolean>();
    const readable: string[] = [];
    for (const format of DOCUMENT_FORMATS) {
      if (!byPermission.has(format.readPermission)) {
        byPermission.set(format.readPermission, await this.permissions.userHasPermission(actorId, format.readPermission));
      }
      if (byPermission.get(format.readPermission)) {
        readable.push(format.key);
      }
    }
    return readable;
  }

  private toItem(row: Row): DocumentListItem {
    const format = findFormat(row.format_key);
    return {
      id: row.id,
      documentId: row.document_id,
      requestId: row.request_id,
      formatKey: row.format_key,
      sgcCode: format?.sgcCode ?? row.format_key,
      formatName: format?.name ?? row.format_key,
      number: row.number,
      status: row.status,
      createdAt: new Date(row.created_at).toISOString(),
      requestedBy: row.requested_by ? { userId: row.requested_by, name: row.requested_by_name } : null,
      asset:
        row.asset_id && row.asset_code
          ? { id: row.asset_id, code: row.asset_code, description: row.asset_description ?? '' }
          : null,
      assetCount: row.asset_count,
      error: row.status === 'FAILED' ? row.error : null,
      attempts: row.attempts,
      retriesAutomatically: row.status === 'FAILED' && (row.attempts ?? 0) < MAX_AUTOMATIC_ATTEMPTS,
      retryable: row.status === 'FAILED',
    };
  }
}
