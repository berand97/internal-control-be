import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Building } from '../../buildings/entities/building.entity.js';
import { Campus } from '../entities/campus.entity.js';
import type {
  CampusRepository,
  CreateCampusRecord,
  UpdateCampusRecord,
} from './campus.repository.interface.js';

@Injectable()
export class TypeOrmCampusRepository implements CampusRepository {
  constructor(
    @InjectRepository(Campus)
    private readonly campus: Repository<Campus>,
    @InjectRepository(Building)
    private readonly buildings: Repository<Building>,
  ) {}

  findAll(isActive?: boolean): Promise<ReadonlyArray<Campus>> {
    return this.campus.find({
      ...(isActive === undefined ? {} : { where: { isActive } }),
      order: { name: 'ASC' },
    });
  }

  findById(id: string): Promise<Campus | null> {
    return this.campus.findOne({ where: { id } });
  }

  insert(record: CreateCampusRecord): Promise<Campus> {
    const now = new Date();
    const entity = this.campus.create({
      ...record,
      createdAt: now,
      updatedAt: now,
    });
    return this.campus.save(entity);
  }

  async update(id: string, record: UpdateCampusRecord): Promise<void> {
    await this.campus.update({ id }, { ...record, updatedAt: new Date() });
  }

  async deactivate(id: string): Promise<void> {
    await this.campus.update(
      { id },
      { isActive: false, updatedAt: new Date() },
    );
  }

  countBuildings(campusId: string): Promise<number> {
    return this.buildings.count({ where: { campusId } });
  }
}
