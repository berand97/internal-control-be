import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Building } from '../../buildings/entities/building.entity.js';
import { Campus } from '../../campus/entities/campus.entity.js';
import { Location } from '../entities/location.entity.js';
import type {
  CreateLocationRecord,
  LocationSearchFilters,
  LocationsRepository,
  LocationWithPath,
  UpdateLocationRecord,
} from './locations.repository.interface.js';

@Injectable()
export class TypeOrmLocationsRepository implements LocationsRepository {
  constructor(
    @InjectRepository(Location)
    private readonly locations: Repository<Location>,
    @InjectRepository(Building)
    private readonly buildings: Repository<Building>,
    @InjectRepository(Campus)
    private readonly campus: Repository<Campus>,
  ) {}

  findByBuilding(
    buildingId: string,
    isActive?: boolean,
  ): Promise<ReadonlyArray<Location>> {
    return this.locations.find({
      where: {
        buildingId,
        ...(isActive === undefined ? {} : { isActive }),
      },
      order: { floorNumber: 'ASC', name: 'ASC' },
    });
  }

  findById(id: string): Promise<Location | null> {
    return this.locations.findOne({ where: { id } });
  }

  async findByIdWithPath(id: string): Promise<LocationWithPath | null> {
    const location = await this.locations.findOne({ where: { id } });
    if (!location) {
      return null;
    }
    const building = await this.buildings.findOne({
      where: { id: location.buildingId },
    });
    if (!building) {
      return null;
    }
    const campus = await this.campus.findOne({
      where: { id: building.campusId },
    });
    if (!campus) {
      return null;
    }
    return { location, building, campus };
  }

  findBuildingById(buildingId: string): Promise<Building | null> {
    return this.buildings.findOne({ where: { id: buildingId } });
  }

  async search(
    filters: LocationSearchFilters,
  ): Promise<ReadonlyArray<LocationWithPath>> {
    const qb = this.locations
      .createQueryBuilder('location')
      .innerJoinAndMapOne(
        'location.building',
        Building,
        'building',
        'building.id = location.building_id',
      )
      .innerJoinAndMapOne(
        'location.campus',
        Campus,
        'campus',
        'campus.id = building.campus_id',
      )
      .orderBy('campus.name', 'ASC')
      .addOrderBy('building.name', 'ASC')
      .addOrderBy('location.floor_number', 'ASC')
      .addOrderBy('location.name', 'ASC');

    if (filters.campusId) {
      qb.andWhere('campus.id = :campusId', { campusId: filters.campusId });
    }
    if (filters.buildingId) {
      qb.andWhere('building.id = :buildingId', {
        buildingId: filters.buildingId,
      });
    }
    if (filters.type) {
      qb.andWhere('location.location_type = :type', { type: filters.type });
    }
    if (filters.q) {
      qb.andWhere(
        '(location.name ILIKE :q OR location.code ILIKE :q OR building.name ILIKE :q)',
        { q: `%${filters.q}%` },
      );
    }

    const rows = await qb.getMany();
    const result: LocationWithPath[] = [];
    for (const row of rows) {
      const withJoins = row as Location & {
        building?: Building;
        campus?: Campus;
      };
      if (withJoins.building && withJoins.campus) {
        result.push({
          location: row,
          building: withJoins.building,
          campus: withJoins.campus,
        });
      }
    }
    return result;
  }

  insert(record: CreateLocationRecord): Promise<Location> {
    const entity = this.locations.create({
      ...record,
      createdAt: new Date(),
    });
    return this.locations.save(entity);
  }

  async update(id: string, record: UpdateLocationRecord): Promise<void> {
    await this.locations.update({ id }, record);
  }

  async deactivate(id: string): Promise<void> {
    await this.locations.update({ id }, { isActive: false });
  }
}
