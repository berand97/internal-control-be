import type { Building } from '../../buildings/entities/building.entity.js';
import type { Campus } from '../../campus/entities/campus.entity.js';
import type { Location } from '../entities/location.entity.js';
import type { LocationType } from '../enums/location-type.enum.js';

export interface CreateLocationRecord {
  readonly buildingId: string;
  readonly code: string;
  readonly name: string;
  readonly floorNumber: number | null;
  readonly locationType: LocationType;
  readonly capacity: number | null;
  readonly isActive: boolean;
}

export interface UpdateLocationRecord {
  readonly code?: string;
  readonly name?: string;
  readonly floorNumber?: number | null;
  readonly locationType?: LocationType;
  readonly capacity?: number | null;
  readonly isActive?: boolean;
}

export interface LocationSearchFilters {
  readonly campusId?: string;
  readonly buildingId?: string;
  readonly type?: LocationType;
  readonly q?: string;
}

export interface LocationWithPath {
  readonly location: Location;
  readonly building: Building;
  readonly campus: Campus;
}

export interface LocationsRepository {
  findByBuilding(
    buildingId: string,
    isActive?: boolean,
  ): Promise<ReadonlyArray<Location>>;
  findById(id: string): Promise<Location | null>;
  findByIdWithPath(id: string): Promise<LocationWithPath | null>;
  findBuildingById(buildingId: string): Promise<Building | null>;
  search(filters: LocationSearchFilters): Promise<ReadonlyArray<LocationWithPath>>;
  insert(record: CreateLocationRecord): Promise<Location>;
  update(id: string, record: UpdateLocationRecord): Promise<void>;
  deactivate(id: string): Promise<void>;
}
