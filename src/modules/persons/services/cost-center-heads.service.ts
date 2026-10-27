import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import type { RequestOrigin } from '../../../common/types/request-origin.type.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import { PermissionsService } from '../../roles/services/permissions.service.js';
import type { AssignCostCenterHeadDto, CostCenterHeadDto } from '../dto/cost-center-head.dto.js';

export const COST_CENTER_HEAD_PERMISSION = 'cost_center:manage:global';
export const COST_CENTER_HEAD_READ_PERMISSION = 'cost_center:read:global';

export const userDisplayNameSubquery = (column: string): string =>
  `(SELECT coalesce(nullif(trim(coalesce(up.first_name, '') || ' ' || coalesce(up.last_name, '')), ''), uu.username)
      FROM app_user uu LEFT JOIN person up ON up.id = uu.person_id WHERE uu.id = ${column})`;

export const HEAD_SELECT = `
  SELECT h.id, h.person_id AS "personId", trim(p.first_name || ' ' || p.last_name) AS "personName",
         p.position_title AS "positionTitle",
         h.cost_center_id AS "costCenterId", cc.external_code AS "costCenterCode", cc.name AS "costCenterName",
         h.valid_from AS "validFrom", h.valid_until AS "validUntil",
         (h.valid_from <= NOW() AND (h.valid_until IS NULL OR h.valid_until > NOW())) AS "isCurrent",
         h.reason, h.assigned_by AS "assignedBy", ${userDisplayNameSubquery('h.assigned_by')} AS "assignedByName",
         h.assigned_at AS "assignedAt", h.ended_at AS "endedAt", h.ended_by AS "endedBy",
         ${userDisplayNameSubquery('h.ended_by')} AS "endedByName", h.end_reason AS "endReason"
  FROM cost_center_head h
  JOIN person p ON p.id = h.person_id
  JOIN cost_center cc ON cc.id = h.cost_center_id`;

const CURRENT = '(h.valid_from <= NOW() AND (h.valid_until IS NULL OR h.valid_until > NOW()))';

export type HeadRow = Omit<CostCenterHeadDto, 'validFrom' | 'validUntil' | 'assignedAt' | 'endedAt'> & {
  validFrom: Date;
  validUntil: Date | null;
  assignedAt: Date;
  endedAt: Date | null;
};

export const toDto = (row: HeadRow): CostCenterHeadDto => ({
  ...row,
  validFrom: row.validFrom.toISOString(),
  validUntil: row.validUntil?.toISOString() ?? null,
  assignedAt: row.assignedAt.toISOString(),
  endedAt: row.endedAt?.toISOString() ?? null,
});

@Injectable()
export class CostCenterHeadsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly permissions: PermissionsService,
    @Inject('AuditLogsRepository')
    private readonly auditLogs: AuditLogsRepository,
  ) {}

  async assign(dto: AssignCostCenterHeadDto, actor: AuthenticatedUser, origin: RequestOrigin): Promise<CostCenterHeadDto> {
    const validFrom = dto.validFrom ? new Date(dto.validFrom) : new Date();
    const validUntil = dto.validUntil ? new Date(dto.validUntil) : null;
    if (validUntil && validUntil <= validFrom) {
      throw new ApiException(ErrorCode.ValidationFailed, 'La fecha de fin debe ser posterior a la de inicio.', [
        { field: 'validUntil', message: 'Debe ser posterior a la fecha de inicio.' },
      ]);
    }
    const id = await this.dataSource.transaction(async (manager) => {
      const [center] = (await manager.query(
        'SELECT id, external_code AS code, name, is_active AS "isActive" FROM cost_center WHERE id = $1 FOR UPDATE',
        [dto.costCenterId],
      )) as Array<{ id: string; code: string; name: string; isActive: boolean }>;
      if (!center) {
        throw new ApiException(ErrorCode.ResourceNotFound, 'No encontramos el centro de costo.');
      }
      if (!center.isActive) {
        const message = `El centro ${center.code} · ${center.name} está archivado. Reactívelo antes de asignarle un jefe.`;
        throw new ApiException(ErrorCode.CostCenterInactive, message, [{ field: 'costCenterId', message }]);
      }
      const [person] = (await manager.query('SELECT id FROM person WHERE id = $1 AND is_active', [
        dto.personId,
      ])) as Array<{ id: string }>;
      if (!person) {
        throw new ApiException(ErrorCode.ResourceNotFound, 'No encontramos a la persona o está inactiva.');
      }
      const [self] = (await manager.query('SELECT 1 FROM app_user WHERE id = $1 AND person_id = $2', [
        actor.id,
        dto.personId,
      ])) as unknown[];
      if (self) {
        throw new ApiException(ErrorCode.RoleSelfAssignmentForbidden);
      }
      const [overlap] = (await manager.query(
        `SELECT 1 FROM cost_center_head
         WHERE person_id = $1 AND cost_center_id = $2
           AND valid_from < coalesce($4::timestamptz, 'infinity')
           AND coalesce(valid_until, 'infinity') > $3::timestamptz`,
        [dto.personId, dto.costCenterId, validFrom, validUntil],
      )) as unknown[];
      if (overlap) {
        throw new ApiException(ErrorCode.CostCenterHeadOverlap);
      }
      const [created] = (await manager.query(
        `INSERT INTO cost_center_head (person_id, cost_center_id, valid_from, valid_until, reason, assigned_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [dto.personId, dto.costCenterId, validFrom, validUntil, dto.reason.trim(), actor.id],
      )) as Array<{ id: string }>;
      const headId = created?.id ?? '';
      await this.audit(manager, headId, actor.id, origin, {
        event: 'COST_CENTER_HEAD_ASSIGNED',
        personId: dto.personId,
        costCenterId: dto.costCenterId,
        validFrom: validFrom.toISOString(),
        validUntil: validUntil?.toISOString() ?? null,
        reason: dto.reason.trim(),
      });
      return headId;
    });
    await this.invalidatePerson(dto.personId);
    return this.get(id);
  }

  async end(id: string, reason: string, actor: AuthenticatedUser, origin: RequestOrigin): Promise<CostCenterHeadDto> {
    const personId = await this.dataSource.transaction(async (manager) => {
      const [head] = (await manager.query(
        `SELECT id, person_id, cost_center_id, ended_at,
                (valid_until IS NOT NULL AND valid_until <= NOW()) AS expired
         FROM cost_center_head WHERE id = $1 FOR UPDATE`,
        [id],
      )) as Array<{ id: string; person_id: string; cost_center_id: string; ended_at: Date | null; expired: boolean }>;
      if (!head) {
        throw new ApiException(ErrorCode.ResourceNotFound, 'No encontramos la jefatura.');
      }
      if (head.ended_at || head.expired) {
        throw new ApiException(ErrorCode.CostCenterHeadEnded);
      }
      await manager.query(
        `UPDATE cost_center_head
         SET valid_until = GREATEST(NOW(), valid_from), ended_at = NOW(), ended_by = $2, end_reason = $3
         WHERE id = $1`,
        [id, actor.id, reason.trim()],
      );
      await this.audit(manager, id, actor.id, origin, {
        event: 'COST_CENTER_HEAD_ENDED',
        personId: head.person_id,
        costCenterId: head.cost_center_id,
        reason: reason.trim(),
      });
      return head.person_id;
    });
    await this.invalidatePerson(personId);
    return this.get(id);
  }

  async byCostCenter(costCenterId: string, current: boolean): Promise<CostCenterHeadDto[]> {
    const [center] = (await this.dataSource.query('SELECT id FROM cost_center WHERE id = $1', [costCenterId])) as unknown[];
    if (!center) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'No encontramos el centro de costo.');
    }
    return this.list('h.cost_center_id = $1', costCenterId, current);
  }

  async byPerson(personId: string, current: boolean): Promise<CostCenterHeadDto[]> {
    const [person] = (await this.dataSource.query('SELECT id FROM person WHERE id = $1', [personId])) as unknown[];
    if (!person) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'No encontramos a la persona.');
    }
    return this.list('h.person_id = $1', personId, current);
  }

  private async list(where: string, id: string, current: boolean): Promise<CostCenterHeadDto[]> {
    const rows = (await this.dataSource.query(
      `${HEAD_SELECT} WHERE ${where}${current ? ` AND ${CURRENT}` : ''}
       ORDER BY h.valid_from DESC, h.id`,
      [id],
    )) as HeadRow[];
    return rows.map(toDto);
  }

  private async get(id: string): Promise<CostCenterHeadDto> {
    const [row] = (await this.dataSource.query(`${HEAD_SELECT} WHERE h.id = $1`, [id])) as HeadRow[];
    if (!row) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'No encontramos la jefatura.');
    }
    return toDto(row);
  }

  private async audit(
    manager: EntityManager,
    headId: string,
    actorId: string,
    origin: RequestOrigin,
    changes: Record<string, unknown>,
  ): Promise<void> {
    await this.auditLogs.record(
      {
        action: AuditAction.CostCenterUpdated,
        entityType: 'COST_CENTER_HEAD',
        entityId: headId,
        performedBy: actorId,
        ...origin,
        changes,
      },
      manager,
    );
  }

  private async invalidatePerson(personId: string): Promise<void> {
    const users = (await this.dataSource.query('SELECT id FROM app_user WHERE person_id = $1', [personId])) as Array<{
      id: string;
    }>;
    this.permissions.invalidateMany(users.map((user) => user.id));
  }
}
