import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { OrganizationalUnit } from '../../organizational-units/entities/organizational-unit.entity.js';
import { CostCenter } from '../entities/cost-center.entity.js';
import { CostCenterSyncLog } from '../entities/cost-center-sync-log.entity.js';
import type {
  CostCenterSearchFilters,
  CostCentersRepository,
  CreateCostCenterRecord,
  CreateSyncLogRecord,
  UpdateCostCenterRecord,
} from './cost-centers.repository.interface.js';

@Injectable()
export class TypeOrmCostCentersRepository implements CostCentersRepository {
  constructor(
    @InjectRepository(CostCenter)
    private readonly costCenters: Repository<CostCenter>,
    @InjectRepository(CostCenterSyncLog)
    private readonly syncLogs: Repository<CostCenterSyncLog>,
    @InjectRepository(OrganizationalUnit)
    private readonly orgUnits: Repository<OrganizationalUnit>,
    private readonly dataSource: DataSource,
  ) {}

  findAll(
    filters: CostCenterSearchFilters,
  ): Promise<ReadonlyArray<CostCenter>> {
    const qb = this.costCenters
      .createQueryBuilder('cc')
      .orderBy('cc.external_code', 'ASC');
    if (filters.organizationalUnitId) {
      qb.andWhere('cc.organizational_unit_id = :orgUnitId', {
        orgUnitId: filters.organizationalUnitId,
      });
    }
    if (filters.isActive !== undefined) {
      qb.andWhere('cc.is_active = :isActive', { isActive: filters.isActive });
    }
    if (filters.q) {
      qb.andWhere('(cc.name ILIKE :q OR cc.external_code ILIKE :q)', {
        q: `%${filters.q}%`,
      });
    }
    return qb.getMany();
  }

  findById(id: string): Promise<CostCenter | null> {
    return this.costCenters.findOne({ where: { id } });
  }

  findActiveById(id: string): Promise<CostCenter | null> {
    return this.costCenters.findOne({ where: { id, isActive: true } });
  }

  findByExternalCode(externalCode: string): Promise<CostCenter | null> {
    return this.costCenters.findOne({ where: { externalCode } });
  }

  findOrgUnitById(id: string): Promise<OrganizationalUnit | null> {
    return this.orgUnits.findOne({ where: { id } });
  }

  findOrgUnitByCode(code: string): Promise<OrganizationalUnit | null> {
    return this.orgUnits.findOne({ where: { code } });
  }

  insert(record: CreateCostCenterRecord): Promise<CostCenter> {
    const now = new Date();
    const entity = this.costCenters.create({
      ...record,
      externalMetadata: null,
      createdAt: now,
      updatedAt: now,
    });
    return this.costCenters.save(entity);
  }

  async update(id: string, record: UpdateCostCenterRecord): Promise<void> {
    await this.costCenters.update({ id }, { ...record, updatedAt: new Date() });
  }

  async deactivate(id: string): Promise<void> {
    await this.costCenters.update(
      { id },
      { isActive: false, updatedAt: new Date() },
    );
  }

  async countActiveAssets(costCenterId: string): Promise<number> {
    const rows: unknown = await this.dataSource.query(
      `
      SELECT COUNT(*)::int AS count
      FROM asset
      WHERE current_cost_center_id = $1
        AND operational_status <> 'WRITTEN_OFF'
      `,
      [costCenterId],
    );
    if (Array.isArray(rows) && rows[0] && typeof rows[0] === 'object') {
      const row = rows[0] as { count?: number };
      return typeof row.count === 'number' ? row.count : 0;
    }
    return 0;
  }

  insertSyncLog(record: CreateSyncLogRecord): Promise<CostCenterSyncLog> {
    const entity = this.syncLogs.create({
      ...record,
      createdAt: new Date(),
    });
    return this.syncLogs.save(entity);
  }
}
