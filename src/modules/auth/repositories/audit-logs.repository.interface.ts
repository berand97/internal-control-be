import type { EntityManager } from 'typeorm';
import type { AuditLog } from '../entities/audit-log.entity.js';
import type { AuditAction } from '../enums/audit-action.enum.js';

export interface AuditEntry {
  readonly action: AuditAction;
  readonly entityType: string;
  readonly entityId: string;
  readonly performedBy: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly changes?: Record<string, unknown>;
}

export interface AuditLogsRepository {
  record(entry: AuditEntry, manager?: EntityManager): Promise<void>;
  findLastLogins(
    userId: string,
    limit: number,
  ): Promise<ReadonlyArray<AuditLog>>;
}
