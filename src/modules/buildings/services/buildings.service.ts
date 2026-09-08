import { Inject, Injectable } from '@nestjs/common';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import { isUniqueViolation } from '../../../common/exceptions/postgres-error.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import { CreateBuildingDto } from '../dto/create-building.dto.js';
import { BuildingResponseDto } from '../dto/responses/building.response.dto.js';
import { UpdateBuildingDto } from '../dto/update-building.dto.js';
import type { BuildingsRepository } from '../repositories/buildings.repository.interface.js';

const BUILDING_ENTITY_TYPE = 'BUILDING';

@Injectable()
export class BuildingsService {
  constructor(
    @Inject('BuildingsRepository')
    private readonly buildingsRepository: BuildingsRepository,
    @Inject('AuditLogsRepository')
    private readonly auditLogsRepository: AuditLogsRepository,
  ) {}

  async list(
    campusId: string,
  ): Promise<ReadonlyArray<BuildingResponseDto>> {
    await this.requireCampus(campusId);
    const items = await this.buildingsRepository.findByCampus(campusId);
    return items.map(BuildingResponseDto.from);
  }

  async getById(
    campusId: string,
    id: string,
  ): Promise<BuildingResponseDto> {
    await this.requireCampus(campusId);
    const building = await this.requireBuilding(id, campusId);
    return BuildingResponseDto.from(building);
  }

  async create(
    campusId: string,
    dto: CreateBuildingDto,
    actor: AuthenticatedUser,
  ): Promise<BuildingResponseDto> {
    const campus = await this.requireCampus(campusId);
    if (!campus.isActive) {
      throw new ApiException(ErrorCode.InvalidState);
    }
    try {
      const building = await this.buildingsRepository.insert({
        campusId: campus.id,
        code: dto.code,
        name: dto.name,
        floorsCount: dto.floorsCount ?? null,
        isActive: dto.isActive ?? true,
      });
      await this.auditLogsRepository.record({
        action: AuditAction.BuildingCreated,
        entityType: BUILDING_ENTITY_TYPE,
        entityId: building.id,
        performedBy: actor.id,
        ipAddress: null,
        userAgent: null,
        changes: { campusId: campus.id, code: building.code },
      });
      return BuildingResponseDto.from(building);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiException(ErrorCode.BuildingCodeAlreadyExists);
      }
      throw error;
    }
  }

  async update(
    campusId: string,
    id: string,
    dto: UpdateBuildingDto,
    actor: AuthenticatedUser,
  ): Promise<BuildingResponseDto> {
    await this.requireCampus(campusId);
    const building = await this.requireBuilding(id, campusId);
    try {
      await this.buildingsRepository.update(building.id, {
        ...(dto.code !== undefined ? { code: dto.code } : {}),
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.floorsCount !== undefined
          ? { floorsCount: dto.floorsCount }
          : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiException(ErrorCode.BuildingCodeAlreadyExists);
      }
      throw error;
    }
    await this.auditLogsRepository.record({
      action: AuditAction.BuildingUpdated,
      entityType: BUILDING_ENTITY_TYPE,
      entityId: building.id,
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
      changes: { ...dto },
    });
    return BuildingResponseDto.from(await this.requireBuilding(id, campusId));
  }

  async remove(
    campusId: string,
    id: string,
    actor: AuthenticatedUser,
  ): Promise<null> {
    await this.requireCampus(campusId);
    const building = await this.requireBuilding(id, campusId);
    const dependents = await this.buildingsRepository.countLocations(
      building.id,
    );
    if (dependents > 0) {
      throw new ApiException(ErrorCode.HasDependentEntities);
    }
    await this.buildingsRepository.deactivate(building.id);
    await this.auditLogsRepository.record({
      action: AuditAction.BuildingDeleted,
      entityType: BUILDING_ENTITY_TYPE,
      entityId: building.id,
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
      changes: { code: building.code },
    });
    return null;
  }

  private async requireCampus(campusId: string) {
    const campus = await this.buildingsRepository.findCampusById(campusId);
    if (!campus) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return campus;
  }

  private async requireBuilding(id: string, campusId: string) {
    const building = await this.buildingsRepository.findById(id);
    if (!building || building.campusId !== campusId) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return building;
  }
}
