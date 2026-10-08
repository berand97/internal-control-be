import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, type EntityManager, Repository } from 'typeorm';
import { CostCenter } from '../../cost-centers/entities/cost-center.entity.js';
import { OrganizationalUnit } from '../entities/organizational-unit.entity.js';
import type {
  CreateOrgUnitRecord,
  OrganizationalUnitsRepository,
  UpdateOrgUnitRecord,
} from './organizational-units.repository.interface.js';

@Injectable()
export class TypeOrmOrganizationalUnitsRepository
  implements OrganizationalUnitsRepository
{
  constructor(
    @InjectRepository(OrganizationalUnit)
    private readonly units: Repository<OrganizationalUnit>,
    @InjectRepository(CostCenter)
    private readonly costCenters: Repository<CostCenter>,
    private readonly dataSource: DataSource,
  ) {}

  findAll(isActive?: boolean): Promise<ReadonlyArray<OrganizationalUnit>> {
    return this.units.find({
      ...(isActive === undefined ? {} : { where: { isActive } }),
      order: { hierarchyLevel: 'ASC', name: 'ASC' },
    });
  }

  findById(id: string): Promise<OrganizationalUnit | null> {
    return this.units.findOne({ where: { id } });
  }

  findActiveById(id: string): Promise<OrganizationalUnit | null> {
    return this.units.findOne({ where: { id, isActive: true } });
  }

  findByCode(code: string): Promise<OrganizationalUnit | null> {
    return this.units.findOne({ where: { code } });
  }

  findActiveByCodePrefix(codePrefix: string): Promise<OrganizationalUnit | null> {
    return this.units.findOne({ where: { codePrefix, isActive: true } });
  }

  findChildren(parentId: string): Promise<ReadonlyArray<OrganizationalUnit>> {
    return this.units.find({
      where: { parentId },
      order: { name: 'ASC' },
    });
  }

  countActiveChildren(parentId: string): Promise<number> {
    return this.units.count({ where: { parentId, isActive: true } });
  }

  countActiveCostCenters(orgUnitId: string): Promise<number> {
    return this.costCenters.count({
      where: { organizationalUnitId: orgUnitId, isActive: true },
    });
  }

  costCenterExists(id: string): Promise<boolean> {
    return this.costCenters.exists({ where: { id } });
  }

  async costCenterCode(id: string): Promise<string | null> {
    const center = await this.costCenters.findOne({ where: { id }, select: { id: true, externalCode: true } });
    return center?.externalCode ?? null;
  }

  async findCostCenterByCode(code: string): Promise<{ readonly id: string; readonly isActive: boolean } | null> {
    const center = await this.costCenters.findOne({ where: { externalCode: code }, select: { id: true, isActive: true } });
    return center ? { id: center.id, isActive: center.isActive } : null;
  }

  insert(record: CreateOrgUnitRecord, manager?: EntityManager): Promise<OrganizationalUnit> {
    const units = manager ? manager.getRepository(OrganizationalUnit) : this.units;
    const now = new Date();
    const entity = units.create({
      ...record,
      createdAt: now,
      updatedAt: now,
    });
    return units.save(entity);
  }

  async update(id: string, record: UpdateOrgUnitRecord, manager?: EntityManager): Promise<void> {
    const units = manager ? manager.getRepository(OrganizationalUnit) : this.units;
    await units.update({ id }, { ...record, updatedAt: new Date() });
  }

  async deactivate(id: string): Promise<void> {
    await this.units.update(
      { id },
      { isActive: false, updatedAt: new Date() },
    );
  }

  async rewriteDescendantPaths(
    oldPath: string,
    newPath: string,
    levelDelta: number,
    manager?: EntityManager,
  ): Promise<void> {
    await (manager ?? this.dataSource.manager).query(
      `
      UPDATE organizational_unit
      SET hierarchy_path = $1 || substr(hierarchy_path, $2),
          hierarchy_level = hierarchy_level + $3,
          updated_at = NOW()
      WHERE hierarchy_path LIKE $4
      `,
      [newPath, oldPath.length + 1, levelDelta, `${oldPath}/%`],
    );
  }
}
