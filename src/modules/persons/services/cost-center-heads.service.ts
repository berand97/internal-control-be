import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import { PermissionsService } from '../../roles/services/permissions.service.js';
import type { AssignCostCenterHeadDto, CostCenterHeadDto } from '../dto/cost-center-head.dto.js';

/** Permiso existente de administración de centros de costo (cost-centers.controller.ts). */
export const COST_CENTER_HEAD_PERMISSION = 'cost_center:manage:global';

const HEAD_SELECT = `
  SELECT h.id, h.person_id AS "personId", trim(p.first_name || ' ' || p.last_name) AS "personName",
         p.position_title AS "positionTitle",
         h.cost_center_id AS "costCenterId", cc.external_code AS "costCenterCode", cc.name AS "costCenterName",
         h.valid_from AS "validFrom", h.valid_until AS "validUntil",
         (h.valid_from <= NOW() AND (h.valid_until IS NULL OR h.valid_until > NOW())) AS "isCurrent",
         h.reason, h.assigned_by AS "assignedBy", h.assigned_at AS "assignedAt",
         h.ended_at AS "endedAt", h.ended_by AS "endedBy", h.end_reason AS "endReason"
  FROM cost_center_head h
  JOIN person p ON p.id = h.person_id
  JOIN cost_center cc ON cc.id = h.cost_center_id`;

const CURRENT = '(h.valid_from <= NOW() AND (h.valid_until IS NULL OR h.valid_until > NOW()))';

type HeadRow = Omit<CostCenterHeadDto, 'validFrom' | 'validUntil' | 'assignedAt' | 'endedAt'> & {
  validFrom: Date;
  validUntil: Date | null;
  assignedAt: Date;
  endedAt: Date | null;
};

const toDto = (row: HeadRow): CostCenterHeadDto => ({
  ...row,
  validFrom: row.validFrom.toISOString(),
  validUntil: row.validUntil?.toISOString() ?? null,
  assignedAt: row.assignedAt.toISOString(),
  endedAt: row.endedAt?.toISOString() ?? null,
});

/**
 * Quién dirige cada centro de costo (HU 1.0.14). Relación a nivel de persona, con vigencia. No se impone un solo
 * jefe por centro (regla no definida por Control Interno); sí se impide que la misma persona tenga dos jefaturas
 * del mismo centro que se traslapen. El alcance de lectura que da una jefatura lo resuelve
 * PermissionsService.costCenterScope; asignar o terminar invalida la caché de permisos de los usuarios de la persona.
 */
@Injectable()
export class CostCenterHeadsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly permissions: PermissionsService,
    @Inject('AuditLogsRepository')
    private readonly auditLogs: AuditLogsRepository,
  ) {}

  async assign(dto: AssignCostCenterHeadDto, actor: AuthenticatedUser): Promise<CostCenterHeadDto> {
    const validFrom = dto.validFrom ? new Date(dto.validFrom) : new Date();
    const validUntil = dto.validUntil ? new Date(dto.validUntil) : null;
    if (validUntil && validUntil <= validFrom) {
      throw new ApiException(ErrorCode.ValidationFailed, 'La fecha de fin debe ser posterior a la de inicio', [
        { field: 'validUntil', message: 'Debe ser posterior a validFrom' },
      ]);
    }
    const id = await this.dataSource.transaction(async (manager) => {
      const [center] = (await manager.query('SELECT id FROM cost_center WHERE id = $1 FOR UPDATE', [
        dto.costCenterId,
      ])) as Array<{ id: string }>;
      if (!center) {
        throw new ApiException(ErrorCode.ResourceNotFound, 'No existe el centro de costo');
      }
      const [person] = (await manager.query('SELECT id FROM person WHERE id = $1 AND is_active', [
        dto.personId,
      ])) as Array<{ id: string }>;
      if (!person) {
        throw new ApiException(ErrorCode.ResourceNotFound, 'No existe la persona o está inactiva');
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
      await this.audit(manager, headId, actor.id, {
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

  async end(id: string, reason: string, actor: AuthenticatedUser): Promise<CostCenterHeadDto> {
    const personId = await this.dataSource.transaction(async (manager) => {
      const [head] = (await manager.query(
        `SELECT id, person_id, cost_center_id, ended_at,
                (valid_until IS NOT NULL AND valid_until <= NOW()) AS expired
         FROM cost_center_head WHERE id = $1 FOR UPDATE`,
        [id],
      )) as Array<{ id: string; person_id: string; cost_center_id: string; ended_at: Date | null; expired: boolean }>;
      if (!head) {
        throw new ApiException(ErrorCode.ResourceNotFound, 'No existe la jefatura');
      }
      if (head.ended_at || head.expired) {
        throw new ApiException(ErrorCode.CostCenterHeadEnded);
      }
      // Una jefatura que aún no empieza termina en su propio inicio: nunca estuvo vigente.
      await manager.query(
        `UPDATE cost_center_head
         SET valid_until = GREATEST(NOW(), valid_from), ended_at = NOW(), ended_by = $2, end_reason = $3
         WHERE id = $1`,
        [id, actor.id, reason.trim()],
      );
      await this.audit(manager, id, actor.id, {
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
      throw new ApiException(ErrorCode.ResourceNotFound, 'No existe el centro de costo');
    }
    return this.list('h.cost_center_id = $1', costCenterId, current);
  }

  async byPerson(personId: string, current: boolean): Promise<CostCenterHeadDto[]> {
    const [person] = (await this.dataSource.query('SELECT id FROM person WHERE id = $1', [personId])) as unknown[];
    if (!person) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'No existe la persona');
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
      throw new ApiException(ErrorCode.ResourceNotFound, 'No existe la jefatura');
    }
    return toDto(row);
  }

  private async audit(
    manager: EntityManager,
    headId: string,
    actorId: string,
    changes: Record<string, unknown>,
  ): Promise<void> {
    // AuditAction no tiene acciones propias de jefatura (el enum vive en auth/**): se registra como cambio del
    // centro de costo, con el evento en changes.event y la jefatura como entidad.
    await this.auditLogs.record(
      {
        action: AuditAction.CostCenterUpdated,
        entityType: 'COST_CENTER_HEAD',
        entityId: headId,
        performedBy: actorId,
        ipAddress: null,
        userAgent: null,
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
