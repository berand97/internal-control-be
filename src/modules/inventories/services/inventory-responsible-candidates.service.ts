import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import { paginatedResult } from '../../../common/types/paginated-result.type.js';
import { scopeSql } from '../domain/inventory-scope-sql.js';
import type {
  InventoryResponsibleCandidateDto,
  InventoryResponsibleCandidatesPageDto,
  QueryInventoryResponsibleCandidatesDto,
} from '../dto/inventory-responsible-candidates.dto.js';
import { InventoryScopeType } from '../enums/inventory-scope.js';
import { USER_DISPLAY_NAME_SQL } from './inventory-summary.js';

/** Permiso de ruta que exige operar una toma (verificar, reportar, cerrar): sin él, el responsable no puede ejecutarla. */
const EXECUTE_PERMISSION = 'inventory:execute:global';

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (char) => `\\${char}`);

/**
 * Usuarios que pueden quedar a cargo de una toma (selector de responsable al programar). Lo usa quien programa
 * (inventory:create:global) sin necesitar user:read:global. Excluye a quien no podría operarla:
 * - usuarios no activos;
 * - sin el permiso efectivo inventory:execute:global (el guard de las rutas de ejecución lo exige también al
 *   responsable);
 * - si se indica el alcance, a quien sería auditado por la toma, con la misma regla de InventoryActorPolicy aplicada
 *   al alcance de hoy: jefe vigente de un centro auditado o custodio (asset.current_responsible_id) de un activo del
 *   alcance. La foto de la toma aún no existe al programar; al ejecutar, la política vuelve a revisar.
 */
@Injectable()
export class InventoryResponsibleCandidatesService {
  constructor(private readonly dataSource: DataSource) {}

  async list(query: QueryInventoryResponsibleCandidatesDto): Promise<InventoryResponsibleCandidatesPageDto> {
    if (query.scope && query.scope !== InventoryScopeType.Global && !query.scopeId) {
      throw new ApiException(ErrorCode.ValidationFailed, 'scopeId es obligatorio si scope no es GLOBAL', [
        { field: 'scopeId', message: 'Requerido si scope no es GLOBAL' },
      ]);
    }
    const params: unknown[] = [EXECUTE_PERMISSION];
    const where = [
      `u.status = 'ACTIVE'`,
      `EXISTS (SELECT 1 FROM v_user_effective_permissions v WHERE v.user_id = u.id AND v.permission_code = $1)`,
    ];
    const q = query.q?.trim();
    if (q) {
      params.push(`%${escapeLike(q)}%`);
      where.push(`(${USER_DISPLAY_NAME_SQL('u', 'p')} ILIKE $${params.length} OR u.username ILIKE $${params.length})`);
    }
    let audited = '';
    if (query.scope) {
      const scope = scopeSql('a', query.scope, query.scopeId ?? null, params.length + 2);
      params.push(query.scope === InventoryScopeType.CostCenter ? (query.scopeId ?? null) : null, ...scope.params);
      const centerParam = `$${params.length - scope.params.length}`;
      audited = `
        WITH audited_assets AS (
          SELECT a.current_cost_center_id AS cost_center_id, a.current_responsible_id AS responsible_id
          FROM asset a
          WHERE a.operational_status <> 'WRITTEN_OFF' AND (${scope.sql})
        ),
        audited_centers AS (
          SELECT cost_center_id AS id FROM audited_assets WHERE cost_center_id IS NOT NULL
          UNION
          SELECT ${centerParam}::uuid WHERE ${centerParam}::uuid IS NOT NULL
        ),
        audited_people AS (
          SELECT h.person_id FROM cost_center_head h
          WHERE h.valid_from <= NOW() AND (h.valid_until IS NULL OR h.valid_until > NOW())
            AND h.cost_center_id IN (SELECT id FROM audited_centers)
          UNION
          SELECT responsible_id FROM audited_assets WHERE responsible_id IS NOT NULL
        )`;
      where.push(`(u.person_id IS NULL OR u.person_id NOT IN (SELECT person_id FROM audited_people))`);
    }
    params.push(query.pageSize, (query.page - 1) * query.pageSize);
    const rows = (await this.dataSource.query(
      `${audited}
       SELECT u.id, ${USER_DISPLAY_NAME_SQL('u', 'p')} AS name, u.username, count(*) OVER () AS total
       FROM app_user u
       LEFT JOIN person p ON p.id = u.person_id
       WHERE ${where.join(' AND ')}
       ORDER BY name, u.username, u.id
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    )) as Array<InventoryResponsibleCandidateDto & { total: string }>;
    const items = rows.map(({ id, name, username }) => ({ id, name, username }));
    return paginatedResult(items, query.page, query.pageSize, Number(rows[0]?.total ?? 0)) as InventoryResponsibleCandidatesPageDto;
  }
}
