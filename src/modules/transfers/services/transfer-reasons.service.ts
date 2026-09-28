import { Inject, Injectable } from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import type { CreateTransferReasonDto, UpdateTransferReasonDto } from '../dto/transfer.dto.js';
import type { TransferReasonDeletedDto, TransferReasonDto } from '../dto/transfer.responses.js';

const SELECT = `SELECT r.id, r.code, r.name, r.description, r.is_active AS "isActive", r.sort_order AS "sortOrder",
    (SELECT count(*)::int FROM asset_transfer_item i WHERE i.reason_id = r.id) AS "usageCount"
  FROM asset_transfer_reason r`;

/**
 * Catálogo de motivos del traslado (columna «Razón» del OCI-17-89). Nace con el único motivo que trae el formato
 * institucional (REUBICACION); los demás los crea quien tenga transfer_catalog:manage:global (Dirección de Control
 * Interno). Un motivo usado no se borra: se desactiva y deja de ofrecerse.
 */
@Injectable()
export class TransferReasonsService {
  constructor(
    private readonly dataSource: DataSource,
    @Inject('AuditLogsRepository')
    private readonly auditLogs: AuditLogsRepository,
  ) {}

  list(): Promise<TransferReasonDto[]> {
    return this.dataSource.query(`${SELECT} ORDER BY r.sort_order, r.name, r.id`) as Promise<TransferReasonDto[]>;
  }

  private async one(id: string): Promise<TransferReasonDto> {
    const [row] = (await this.dataSource.query(`${SELECT} WHERE r.id = $1`, [id])) as TransferReasonDto[];
    if (!row) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'No existe el motivo de traslado');
    }
    return row;
  }

  async create(dto: CreateTransferReasonDto, actor: AuthenticatedUser): Promise<TransferReasonDto> {
    const name = dto.name.trim();
    if (!name) {
      throw new ApiException(ErrorCode.ValidationFailed, 'El nombre es obligatorio', [{ field: 'name', message: 'Obligatorio' }]);
    }
    try {
      const id = await this.dataSource.transaction(async (manager) => {
        const [row] = (await manager.query(
          `INSERT INTO asset_transfer_reason (code, name, description, sort_order, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $5) RETURNING id`,
          [dto.code, name, dto.description?.trim() || null, dto.sortOrder ?? 0, actor.id],
        )) as Array<{ id: string }>;
        await this.auditLogs.record(
          {
            action: AuditAction.TransferReasonChanged,
            entityType: 'TRANSFER_REASON',
            entityId: row?.id ?? '',
            performedBy: actor.id,
            ipAddress: null,
            userAgent: null,
            changes: { created: { code: dto.code, name } },
          },
          manager,
        );
        return row?.id ?? '';
      });
      return this.one(id);
    } catch (error) {
      if (error instanceof QueryFailedError && (error.driverError as { constraint?: string })?.constraint === 'uq_asset_transfer_reason_code') {
        throw new ApiException(ErrorCode.TransferReasonExists);
      }
      throw error;
    }
  }

  async update(id: string, dto: UpdateTransferReasonDto, actor: AuthenticatedUser): Promise<TransferReasonDto> {
    const before = await this.one(id);
    const name = dto.name === undefined ? undefined : dto.name.trim();
    if (name === '') {
      throw new ApiException(ErrorCode.ValidationFailed, 'El nombre es obligatorio', [{ field: 'name', message: 'Obligatorio' }]);
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `UPDATE asset_transfer_reason SET
           name = coalesce($2, name),
           description = CASE WHEN $3::boolean THEN $4 ELSE description END,
           is_active = coalesce($5, is_active),
           sort_order = coalesce($6, sort_order),
           updated_by = $7, updated_at = NOW()
         WHERE id = $1`,
        [
          id,
          name ?? null,
          dto.description !== undefined,
          dto.description?.trim() || null,
          dto.isActive ?? null,
          dto.sortOrder ?? null,
          actor.id,
        ],
      );
      await this.auditLogs.record(
        {
          action: AuditAction.TransferReasonChanged,
          entityType: 'TRANSFER_REASON',
          entityId: id,
          performedBy: actor.id,
          ipAddress: null,
          userAgent: null,
          changes: {
            before: { name: before.name, description: before.description, isActive: before.isActive, sortOrder: before.sortOrder },
            after: dto,
          },
        },
        manager,
      );
    });
    return this.one(id);
  }

  async remove(id: string, actor: AuthenticatedUser): Promise<TransferReasonDeletedDto> {
    const reason = await this.one(id);
    if (reason.usageCount > 0) {
      throw new ApiException(ErrorCode.TransferReasonInUse);
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.query('DELETE FROM asset_transfer_reason WHERE id = $1', [id]);
      await this.auditLogs.record(
        {
          action: AuditAction.TransferReasonChanged,
          entityType: 'TRANSFER_REASON',
          entityId: id,
          performedBy: actor.id,
          ipAddress: null,
          userAgent: null,
          changes: { deleted: { code: reason.code, name: reason.name } },
        },
        manager,
      );
    });
    return { id, deleted: true };
  }
}
