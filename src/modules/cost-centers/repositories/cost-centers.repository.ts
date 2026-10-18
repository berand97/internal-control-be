import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { type EntityManager, Repository } from 'typeorm';
import { OrganizationalUnit } from '../../organizational-units/entities/organizational-unit.entity.js';
import { CostCenter } from '../entities/cost-center.entity.js';
import type {
  CostCenterSearchFilters,
  CostCentersRepository,
  CreateCostCenterRecord,
  UpdateCostCenterRecord,
} from './cost-centers.repository.interface.js';

@Injectable()
export class TypeOrmCostCentersRepository implements CostCentersRepository {
  constructor(
    @InjectRepository(CostCenter)
    private readonly costCenters: Repository<CostCenter>,
    @InjectRepository(OrganizationalUnit)
    private readonly orgUnits: Repository<OrganizationalUnit>,
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

  findOrgUnitById(id: string): Promise<OrganizationalUnit | null> {
    return this.orgUnits.findOne({ where: { id } });
  }

  insert(record: CreateCostCenterRecord, manager?: EntityManager): Promise<CostCenter> {
    const repository = manager ? manager.getRepository(CostCenter) : this.costCenters;
    const now = new Date();
    const entity = repository.create({
      ...record,
      externalMetadata: null,
      createdAt: now,
      updatedAt: now,
    });
    return repository.save(entity);
  }

  async update(id: string, record: UpdateCostCenterRecord, manager?: EntityManager): Promise<void> {
    const repository = manager ? manager.getRepository(CostCenter) : this.costCenters;
    await repository.update({ id }, { ...record, updatedAt: new Date() });
  }
}
