import { Inject, Injectable } from '@nestjs/common';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import { isUniqueViolation } from '../../../common/exceptions/postgres-error.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import { CreateLocationDto } from '../dto/create-location.dto.js';
import { QueryLocationsDto } from '../dto/query-locations.dto.js';
import { LocationResponseDto } from '../dto/responses/location.response.dto.js';
import { UpdateLocationDto } from '../dto/update-location.dto.js';
import type { LocationsRepository } from '../repositories/locations.repository.interface.js';

const LOCATION_ENTITY_TYPE = 'LOCATION';

@Injectable()
export class LocationsService {
  constructor(
    @Inject('LocationsRepository')
    private readonly locationsRepository: LocationsRepository,
    @Inject('AuditLogsRepository')
    private readonly auditLogsRepository: AuditLogsRepository,
  ) {}

  async search(
    query: QueryLocationsDto,
  ): Promise<ReadonlyArray<LocationResponseDto>> {
    const items = await this.locationsRepository.search({
      ...(query.campusId ? { campusId: query.campusId } : {}),
      ...(query.buildingId ? { buildingId: query.buildingId } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.q ? { q: query.q } : {}),
    });
    return items.map((item) =>
      LocationResponseDto.from(item.location, item.building, item.campus),
    );
  }

  async listByBuilding(
    buildingId: string,
  ): Promise<ReadonlyArray<LocationResponseDto>> {
    await this.requireBuilding(buildingId);
    const items = await this.locationsRepository.search({ buildingId });
    return items.map((item) =>
      LocationResponseDto.from(item.location, item.building, item.campus),
    );
  }

  async getById(
    buildingId: string,
    id: string,
  ): Promise<LocationResponseDto> {
    await this.requireBuilding(buildingId);
    const found = await this.locationsRepository.findByIdWithPath(id);
    if (!found || found.location.buildingId !== buildingId) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return LocationResponseDto.from(
      found.location,
      found.building,
      found.campus,
    );
  }

  async create(
    buildingId: string,
    dto: CreateLocationDto,
    actor: AuthenticatedUser,
  ): Promise<LocationResponseDto> {
    const building = await this.requireBuilding(buildingId);
    if (!building.isActive) {
      throw new ApiException(ErrorCode.InvalidState);
    }
    try {
      const location = await this.locationsRepository.insert({
        buildingId: building.id,
        code: dto.code,
        name: dto.name,
        floorNumber: dto.floor ?? null,
        locationType: dto.type,
        capacity: dto.capacity ?? null,
        isActive: dto.isActive ?? true,
      });
      await this.auditLogsRepository.record({
        action: AuditAction.LocationCreated,
        entityType: LOCATION_ENTITY_TYPE,
        entityId: location.id,
        performedBy: actor.id,
        ipAddress: null,
        userAgent: null,
        changes: { buildingId: building.id, code: location.code },
      });
      const found = await this.locationsRepository.findByIdWithPath(
        location.id,
      );
      if (!found) {
        throw new ApiException(ErrorCode.InternalError);
      }
      return LocationResponseDto.from(
        found.location,
        found.building,
        found.campus,
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiException(ErrorCode.LocationCodeAlreadyExists);
      }
      throw error;
    }
  }

  async update(
    buildingId: string,
    id: string,
    dto: UpdateLocationDto,
    actor: AuthenticatedUser,
  ): Promise<LocationResponseDto> {
    await this.requireBuilding(buildingId);
    const existing = await this.locationsRepository.findById(id);
    if (!existing || existing.buildingId !== buildingId) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    try {
      await this.locationsRepository.update(existing.id, {
        ...(dto.code !== undefined ? { code: dto.code } : {}),
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.floor !== undefined ? { floorNumber: dto.floor } : {}),
        ...(dto.type !== undefined ? { locationType: dto.type } : {}),
        ...(dto.capacity !== undefined ? { capacity: dto.capacity } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiException(ErrorCode.LocationCodeAlreadyExists);
      }
      throw error;
    }
    await this.auditLogsRepository.record({
      action: AuditAction.LocationUpdated,
      entityType: LOCATION_ENTITY_TYPE,
      entityId: existing.id,
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
      changes: { ...dto },
    });
    return this.getById(buildingId, id);
  }

  async remove(
    buildingId: string,
    id: string,
    actor: AuthenticatedUser,
  ): Promise<null> {
    await this.requireBuilding(buildingId);
    const location = await this.locationsRepository.findById(id);
    if (!location || location.buildingId !== buildingId) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    await this.locationsRepository.deactivate(location.id);
    await this.auditLogsRepository.record({
      action: AuditAction.LocationDeleted,
      entityType: LOCATION_ENTITY_TYPE,
      entityId: location.id,
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
      changes: { code: location.code },
    });
    return null;
  }

  private async requireBuilding(buildingId: string) {
    const building = await this.locationsRepository.findBuildingById(buildingId);
    if (!building) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return building;
  }
}
