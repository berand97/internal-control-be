import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Campus } from '../../campus/entities/campus.entity.js';
import { Location } from '../../locations/entities/location.entity.js';
import { Building } from '../entities/building.entity.js';
import type {
  BuildingsRepository,
  CreateBuildingRecord,
  UpdateBuildingRecord,
} from './buildings.repository.interface.js';

@Injectable()
export class TypeOrmBuildingsRepository implements BuildingsRepository {
  constructor(
    @InjectRepository(Building)
    private readonly buildings: Repository<Building>,
    @InjectRepository(Campus)
    private readonly campus: Repository<Campus>,
    @InjectRepository(Location)
    private readonly locations: Repository<Location>,
  ) {}

  findByCampus(
    campusId: string,
    isActive?: boolean,
  ): Promise<ReadonlyArray<Building>> {
    return this.buildings.find({
      where: {
        campusId,
        ...(isActive === undefined ? {} : { isActive }),
      },
      order: { name: 'ASC' },
    });
  }

  findById(id: string): Promise<Building | null> {
    return this.buildings.findOne({ where: { id } });
  }

  findCampusById(campusId: string): Promise<Campus | null> {
    return this.campus.findOne({ where: { id: campusId } });
  }

  insert(record: CreateBuildingRecord): Promise<Building> {
    const entity = this.buildings.create({
      ...record,
      createdAt: new Date(),
    });
    return this.buildings.save(entity);
  }

  async update(id: string, record: UpdateBuildingRecord): Promise<void> {
    await this.buildings.update({ id }, record);
  }

  async deactivate(id: string): Promise<void> {
    await this.buildings.update({ id }, { isActive: false });
  }

  countLocations(buildingId: string): Promise<number> {
    return this.locations.count({ where: { buildingId } });
  }
}
