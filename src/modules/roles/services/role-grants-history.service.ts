import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { paginatedResult } from '../../../common/types/paginated-result.type.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import type {
  QueryRoleGrantsHistoryDto,
  RoleGrantEvent,
  RoleGrantHistoryItemDto,
  RoleGrantPermissionDto,
  RoleGrantsHistoryPageDto,
} from '../dto/role-grants-history.dto.js';

/** Acción de bitácora → evento del contrato. Solo otorgamientos y retiros de roles y permisos. */
const EVENT_BY_ACTION: Readonly<Record<string, RoleGrantEvent>> = {
  [AuditAction.RoleCreated]: 'ROLE_CREATED',
  [AuditAction.RoleUpdated]: 'ROLE_UPDATED',
  [AuditAction.RoleDeleted]: 'ROLE_DELETED',
  [AuditAction.RolePermsSet]: 'ROLE_PERMISSIONS_CHANGED',
  [AuditAction.UserCreated]: 'USER_CREATED_WITH_ROLE',
  [AuditAction.UserRoleGranted]: 'USER_ROLE_GRANTED',
  [AuditAction.UserRoleRevoked]: 'USER_ROLE_REVOKED',
  [AuditAction.UserRoleDelegated]: 'USER_ROLE_DELEGATED',
};
const ACTION_BY_EVENT = Object.fromEntries(Object.entries(EVENT_BY_ACTION).map(([action, event]) => [event, action]));
const ROLE_ACTIONS: ReadonlySet<string> = new Set([
  AuditAction.RoleCreated,
  AuditAction.RoleUpdated,
  AuditAction.RoleDeleted,
  AuditAction.RolePermsSet,
]);
/** Campos de PATCH /roles/:id que describen la edición (el resto de changes es contexto). */
const ROLE_FIELDS = ['name', 'description', 'parentRoleId', 'superiorRoleId'] as const;
const SCOPE_TYPES = ['GLOBAL', 'ORG_UNIT', 'COST_CENTER'] as const;

const USER_NAME = (alias: string) =>
  `coalesce(nullif(trim(coalesce(${alias}p.first_name, '') || ' ' || coalesce(${alias}p.last_name, '')), ''), ${alias}u.username)`;

interface Row {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  changes: Record<string, unknown> | null;
  performed_by: string | null;
  performed_at: Date;
  ip_address: string | null;
  user_agent: string | null;
  actor_name: string | null;
  target_name: string | null;
  role_id: string | null;
  role_code: string | null;
  role_name: string | null;
  total: string;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * Historial de otorgamientos y retiros (permiso a rol, rol a usuario, creación/edición/borrado de rol), leído de
 * audit_log. Nunca devuelve `changes` crudo: solo campos estructurados (sin correos, documentos ni secretos).
 */
@Injectable()
export class RoleGrantsHistoryService {
  constructor(private readonly dataSource: DataSource) {}

  async list(query: QueryRoleGrantsHistoryDto): Promise<RoleGrantsHistoryPageDto> {
    const params: unknown[] = [];
    const bind = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const actions = query.event ? [ACTION_BY_EVENT[query.event]] : Object.keys(EVENT_BY_ACTION);
    const where = [`a.action = ANY(${bind(actions)}::text[])`, `a.entity_type IN ('ROLE', 'USER')`];
    if (query.roleId) {
      const role = bind(query.roleId);
      where.push(`((a.entity_type = 'ROLE' AND a.entity_id = ${role}::uuid) OR a.changes->>'roleId' = ${role}::text)`);
    }
    if (query.permissionId) {
      const permission = bind(query.permissionId);
      where.push(`(a.changes->'addedPermissionIds' ? ${permission}::text
                   OR a.changes->'removedPermissionIds' ? ${permission}::text
                   OR a.changes->>'removedPermissionId' = ${permission}::text
                   OR (a.action = '${AuditAction.RoleCreated}' AND a.changes->'permissionIds' ? ${permission}::text))`);
    }
    if (query.userId) {
      where.push(`(a.entity_type = 'USER' AND a.entity_id = ${bind(query.userId)}::uuid)`);
    }
    if (query.performedBy) {
      where.push(`a.performed_by = ${bind(query.performedBy)}::uuid`);
    }
    if (query.from) {
      where.push(`a.performed_at >= ${bind(new Date(query.from))}::timestamptz`);
    }
    if (query.to) {
      where.push(`a.performed_at < ${bind(new Date(query.to))}::timestamptz`);
    }
    const limit = bind(query.pageSize);
    const offset = bind((query.page - 1) * query.pageSize);
    const rows = (await this.dataSource.query(
      `SELECT a.id::text AS id, a.action, a.entity_type, a.entity_id, a.changes, a.performed_by, a.performed_at,
              host(a.ip_address) AS ip_address, a.user_agent,
              ${USER_NAME('a')} AS actor_name,
              ${USER_NAME('t')} AS target_name,
              r.id AS role_id, r.code AS role_code, r.name AS role_name,
              count(*) OVER () AS total
       FROM audit_log a
       LEFT JOIN app_user au ON au.id = a.performed_by
       LEFT JOIN person ap ON ap.id = au.person_id
       LEFT JOIN app_user tu ON a.entity_type = 'USER' AND tu.id = a.entity_id
       LEFT JOIN person tp ON tp.id = tu.person_id
       LEFT JOIN role r ON r.id = CASE
         WHEN a.entity_type = 'ROLE' THEN a.entity_id
         WHEN a.changes->>'roleId' ~* '^[0-9a-f-]{36}$' THEN (a.changes->>'roleId')::uuid
       END
       WHERE ${where.join(' AND ')}
       ORDER BY a.performed_at DESC, a.id DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    )) as Row[];
    const codes = await this.permissionCodes(rows);
    const items = rows.map((row) => this.toItem(row, codes));
    return paginatedResult(items, query.page, query.pageSize, Number(rows[0]?.total ?? 0)) as RoleGrantsHistoryPageDto;
  }

  /** Códigos de los permisos citados por id en registros que no guardaron el código (anteriores a este cambio). */
  private async permissionCodes(rows: ReadonlyArray<Row>): Promise<ReadonlyMap<string, string>> {
    const ids = new Set<string>();
    for (const row of rows) {
      const changes = row.changes ?? {};
      for (const key of ['addedPermissionIds', 'removedPermissionIds', 'permissionIds']) {
        strings(changes[key]).forEach((id) => ids.add(id));
      }
      const removed = text(changes['removedPermissionId']);
      if (removed) {
        ids.add(removed);
      }
    }
    if (ids.size === 0) {
      return new Map();
    }
    const found = (await this.dataSource.query(`SELECT id, code FROM permission WHERE id = ANY($1::uuid[])`, [
      [...ids],
    ])) as Array<{ id: string; code: string }>;
    return new Map(found.map((item) => [item.id, item.code]));
  }

  private toItem(row: Row, codes: ReadonlyMap<string, string>): RoleGrantHistoryItemDto {
    const changes = row.changes ?? {};
    const refs = (idsKey: string, codesKey: string): RoleGrantPermissionDto[] => {
      const ids = strings(changes[idsKey]);
      const stored = Array.isArray(changes[codesKey]) ? (changes[codesKey] as unknown[]) : [];
      return ids.map((id, index) => ({ id, code: text(stored[index]) ?? codes.get(id) ?? null }));
    };
    let added = refs('addedPermissionIds', 'addedPermissionCodes');
    let removed = refs('removedPermissionIds', 'removedPermissionCodes');
    // Registros anteriores: la creación guardaba permissionIds y el retiro removedPermissionId.
    if (row.action === AuditAction.RoleCreated && added.length === 0) {
      added = strings(changes['permissionIds']).map((id) => ({ id, code: codes.get(id) ?? null }));
    }
    const legacyRemoved = text(changes['removedPermissionId']);
    if (legacyRemoved && removed.length === 0) {
      removed = [{ id: legacyRemoved, code: codes.get(legacyRemoved) ?? null }];
    }
    const isRoleEvent = ROLE_ACTIONS.has(row.action);
    const roleId = row.role_id ?? (isRoleEvent ? row.entity_id : text(changes['roleId']));
    const scopeType = text(changes['scopeType']);
    return {
      id: row.id,
      performedAt: row.performed_at.toISOString(),
      event: EVENT_BY_ACTION[row.action] ?? 'ROLE_UPDATED',
      performedBy: row.performed_by ? { id: row.performed_by, name: row.actor_name ?? '' } : null,
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
      role: roleId
        ? { id: roleId, code: row.role_code ?? text(changes['roleCode']) ?? text(changes['code']), name: row.role_name }
        : null,
      targetUser: row.entity_type === 'USER' ? { id: row.entity_id, name: row.target_name ?? '' } : null,
      addedPermissions: added,
      removedPermissions: removed,
      scopeType: SCOPE_TYPES.find((item) => item === scopeType) ?? null,
      scopeId: text(changes['scopeId']),
      validFrom: text(changes['validFrom']),
      validUntil: text(changes['validUntil']),
      changedFields: row.action === AuditAction.RoleUpdated ? ROLE_FIELDS.filter((field) => field in changes) : [],
      reason: text(changes['reason']),
    };
  }
}
