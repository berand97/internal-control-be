import { Inject, Injectable } from '@nestjs/common';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import { isUniqueViolation } from '../../../common/exceptions/postgres-error.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import { CreateCampusDto } from '../dto/create-campus.dto.js';
import { QueryCampusDto } from '../dto/query-campus.dto.js';
import { CampusResponseDto } from '../dto/responses/campus.response.dto.js';
import { UpdateCampusDto } from '../dto/update-campus.dto.js';
import type { CampusRepository } from '../repositories/campus.repository.interface.js';

const CAMPUS_ENTITY_TYPE = 'CAMPUS';

@Injectable()
export class CampusService {
  constructor(
    @Inject('CampusesRepository')
    private readonly campusRepository: CampusRepository,
    @Inject('AuditLogsRepository')
    private readonly auditLogsRepository: AuditLogsRepository,
  ) {}

  async list(query: QueryCampusDto): Promise<ReadonlyArray<CampusResponseDto>> {
    const items = await this.campusRepository.findAll(query.isActive);
    return items.map(CampusResponseDto.from);
  }

  async getById(id: string): Promise<CampusResponseDto> {
    return CampusResponseDto.from(await this.requireCampus(id));
  }

  async create(
    dto: CreateCampusDto,
    actor: AuthenticatedUser,
  ): Promise<CampusResponseDto> {
    try {
      const campus = await this.campusRepository.insert({
        code: dto.code,
        name: dto.name,
        address: dto.address ?? null,
        city: dto.city ?? null,
        department: dto.department ?? null,
        country: dto.country ?? null,
        isActive: dto.isActive ?? true,
      });
      await this.auditLogsRepository.record({
        action: AuditAction.CampusCreated,
        entityType: CAMPUS_ENTITY_TYPE,
        entityId: campus.id,
        performedBy: actor.id,
        ipAddress: null,
        userAgent: null,
        changes: { code: campus.code },
      });
      return CampusResponseDto.from(campus);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiException(ErrorCode.CampusCodeAlreadyExists);
      }
      throw error;
    }
  }

  async update(
    id: string,
    dto: UpdateCampusDto,
    actor: AuthenticatedUser,
  ): Promise<CampusResponseDto> {
    await this.requireCampus(id);
    try {
      await this.campusRepository.update(id, {
        ...(dto.code !== undefined ? { code: dto.code } : {}),
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.address !== undefined ? { address: dto.address } : {}),
        ...(dto.city !== undefined ? { city: dto.city } : {}),
        ...(dto.department !== undefined ? { department: dto.department } : {}),
        ...(dto.country !== undefined ? { country: dto.country } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiException(ErrorCode.CampusCodeAlreadyExists);
      }
      throw error;
    }
    await this.auditLogsRepository.record({
      action: AuditAction.CampusUpdated,
      entityType: CAMPUS_ENTITY_TYPE,
      entityId: id,
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
      changes: { ...dto },
    });
    return CampusResponseDto.from(await this.requireCampus(id));
  }

  async remove(id: string, actor: AuthenticatedUser): Promise<null> {
    const campus = await this.requireCampus(id);
    const dependents = await this.campusRepository.countBuildings(campus.id);
    if (dependents > 0) {
      throw new ApiException(ErrorCode.HasDependentEntities);
    }
    await this.campusRepository.deactivate(campus.id);
    await this.auditLogsRepository.record({
      action: AuditAction.CampusDeleted,
      entityType: CAMPUS_ENTITY_TYPE,
      entityId: campus.id,
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
      changes: { code: campus.code },
    });
    return null;
  }

  private async requireCampus(id: string) {
    const campus = await this.campusRepository.findById(id);
    if (!campus) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return campus;
  }
}
