import type { Campus } from '../../campus/entities/campus.entity.js';
import type { Building } from '../entities/building.entity.js';

export interface CreateBuildingRecord {
  readonly campusId: string;
  readonly code: string;
  readonly name: string;
  readonly floorsCount: number | null;
  readonly isActive: boolean;
}

export interface UpdateBuildingRecord {
  readonly code?: string;
  readonly name?: string;
  readonly floorsCount?: number | null;
  readonly isActive?: boolean;
}

export interface BuildingsRepository {
  findByCampus(
    campusId: string,
    isActive?: boolean,
  ): Promise<ReadonlyArray<Building>>;
  findById(id: string): Promise<Building | null>;
  findCampusById(campusId: string): Promise<Campus | null>;
  insert(record: CreateBuildingRecord): Promise<Building>;
  update(id: string, record: UpdateBuildingRecord): Promise<void>;
  deactivate(id: string): Promise<void>;
  countLocations(buildingId: string): Promise<number>;
}
