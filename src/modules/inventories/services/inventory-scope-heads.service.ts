import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import { scopeSql } from '../domain/inventory-scope-sql.js';
import type {
  InventoryScopeHeadDto,
  InventoryScopeHeadsResponseDto,
  QueryInventoryScopeHeadsDto,
} from '../dto/inventory-scope-heads.dto.js';
import { InventoryScopeType } from '../enums/inventory-scope.js';

@Injectable()
export class InventoryScopeHeadsService {
  constructor(private readonly dataSource: DataSource) {}

  async list(query: QueryInventoryScopeHeadsDto): Promise<InventoryScopeHeadsResponseDto> {
    if (query.scope !== InventoryScopeType.Global && !query.scopeId) {
      throw new ApiException(ErrorCode.ValidationFailed, 'Elija el alcance de la toma.', [
        { field: 'scopeId', message: 'Elija el alcance de la toma.' },
      ]);
    }
    if (query.scope === InventoryScopeType.Global) {
      return { items: [] };
    }

    const params: unknown[] = [];
    let centersSql: string;
    if (query.scope === InventoryScopeType.CostCenter) {
      params.push(query.scopeId);
      centersSql = `SELECT $1::uuid AS id`;
    } else {
      const scope = scopeSql('a', query.scope, query.scopeId ?? null, 1);
      params.push(...scope.params);
      centersSql = `
        SELECT DISTINCT a.current_cost_center_id AS id
        FROM asset a
        WHERE a.operational_status <> 'WRITTEN_OFF'
          AND a.current_cost_center_id IS NOT NULL
          AND (${scope.sql})`;
    }

    const rows = (await this.dataSource.query(
      `SELECT DISTINCT ON (p.id) p.id AS "personId",
              trim(p.first_name || ' ' || p.last_name) AS name
       FROM cost_center_head h
       JOIN person p ON p.id = h.person_id
       WHERE h.cost_center_id IN (${centersSql})
         AND h.valid_from <= NOW()
         AND (h.valid_until IS NULL OR h.valid_until > NOW())
         AND p.is_active
       ORDER BY p.id, name`,
      params,
    )) as InventoryScopeHeadDto[];

    return { items: rows };
  }
}
