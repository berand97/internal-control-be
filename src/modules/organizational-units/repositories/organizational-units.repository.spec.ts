import { describe, expect, it, vi } from 'vitest';
import type { DataSource, Repository } from 'typeorm';
import { currentHeadCondition } from '../../cost-centers/domain/cost-center-head-rule.js';
import type { CostCenter } from '../../cost-centers/entities/cost-center.entity.js';
import type { OrganizationalUnit } from '../entities/organizational-unit.entity.js';
import { TypeOrmOrganizationalUnitsRepository } from './organizational-units.repository.js';

describe('TypeOrmOrganizationalUnitsRepository.findActiveCostCentersOfUnit', () => {
  const build = (rows: unknown[]) => {
    const query = vi.fn().mockResolvedValue(rows);
    const repository = new TypeOrmOrganizationalUnitsRepository(
      {} as Repository<OrganizationalUnit>,
      {} as Repository<CostCenter>,
      { query } as unknown as DataSource,
    );
    return { repository, query };
  };

  it('una sola consulta: centros activos directos de la unidad, jefe vigente con la regla de jefe y conteo agrupado sin bajas', async () => {
    const row = { id: 'c1', code: '4010', name: 'Vicerrectoría', acceptsAssets: true, headPersonId: 'p1', headFullName: 'Ana Pérez', assetCount: 2 };
    const { repository, query } = build([row]);
    const at = new Date('2030-01-01T00:00:00Z');

    expect(await repository.findActiveCostCentersOfUnit('u1', at)).toEqual([row]);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(['u1', at]);
    expect(sql).toContain(currentHeadCondition('cc.id', '$2::timestamptz'));
    expect(sql).toContain("operational_status <> 'WRITTEN_OFF'");
    expect(sql).toContain('GROUP BY current_cost_center_id');
    expect(sql).toContain('WHERE cc.organizational_unit_id = $1 AND cc.is_active');
    expect(sql).toContain('ORDER BY cc.external_code');
    expect(sql).not.toMatch(/document_number|email/);
  });
});
