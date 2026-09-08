import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLog } from '../entities/audit-log.entity.js';
import { AuditAction } from '../enums/audit-action.enum.js';
import {
  AuditEntry,
  AuditLogsRepository,
} from './audit-logs.repository.interface.js';

@Injectable()
export class TypeOrmAuditLogsRepository implements AuditLogsRepository {
  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogs: Repository<AuditLog>,
  ) {}

  async record(entry: AuditEntry): Promise<void> {
    const auditLog = new AuditLog();
    auditLog.action = entry.action;
    auditLog.entityType = entry.entityType;
    auditLog.entityId = entry.entityId;
    auditLog.performedBy = entry.performedBy;
    auditLog.ipAddress = entry.ipAddress;
    auditLog.userAgent = entry.userAgent;
    auditLog.changes = entry.changes ?? null;
    await this.auditLogs.save(auditLog);
  }

  findLastLogins(
    userId: string,
    limit: number,
  ): Promise<ReadonlyArray<AuditLog>> {
    return this.auditLogs.find({
      where: {
        entityType: 'USER',
        entityId: userId,
        action: AuditAction.Login,
      },
      order: { performedAt: 'DESC' },
      take: limit,
    });
  }
}
