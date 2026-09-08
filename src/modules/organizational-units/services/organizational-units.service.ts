import { Inject, Injectable } from '@nestjs/common';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import {
  isOrgUnitCycle,
  isUniqueViolation,
} from '../../../common/exceptions/postgres-error.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import { CreateOrganizationalUnitDto } from '../dto/create-organizational-unit.dto.js';
import { QueryOrganizationalUnitsDto } from '../dto/query-organizational-units.dto.js';
import { OrganizationalUnitTreeResponseDto } from '../dto/responses/organizational-unit-tree.response.dto.js';
import { OrganizationalUnitResponseDto } from '../dto/responses/organizational-unit.response.dto.js';
import { UpdateOrganizationalUnitDto } from '../dto/update-organizational-unit.dto.js';
import type { OrganizationalUnit } from '../entities/organizational-unit.entity.js';
import type { OrganizationalUnitsRepository } from '../repositories/organizational-units.repository.interface.js';

const ORG_UNIT_ENTITY_TYPE = 'ORG_UNIT';

const toPathSegment = (code: string): string => code.toLowerCase();

const childPath = (parentPath: string | null, code: string): string =>
  parentPath ? `${parentPath}/${toPathSegment(code)}` : `/${toPathSegment(code)}`;

const buildTree = (
  units: ReadonlyArray<OrganizationalUnit>,
  parentId: string | null,
): ReadonlyArray<OrganizationalUnitTreeResponseDto> =>
  units
    .filter((unit) => unit.parentId === parentId)
    .map((unit) =>
      OrganizationalUnitTreeResponseDto.from(unit, buildTree(units, unit.id)),
    );

@Injectable()
export class OrganizationalUnitsService {
  constructor(
    @Inject('OrganizationalUnitsRepository')
    private readonly unitsRepository: OrganizationalUnitsRepository,
    @Inject('AuditLogsRepository')
    private readonly auditLogsRepository: AuditLogsRepository,
  ) {}

  async list(
    query: QueryOrganizationalUnitsDto,
  ): Promise<ReadonlyArray<OrganizationalUnitResponseDto>> {
    const items = await this.unitsRepository.findAll(query.isActive);
    return items.map(OrganizationalUnitResponseDto.from);
  }

  async tree(): Promise<ReadonlyArray<OrganizationalUnitTreeResponseDto>> {
    const items = await this.unitsRepository.findAll();
    return buildTree(items, null);
  }

  async getById(id: string): Promise<OrganizationalUnitResponseDto> {
    return OrganizationalUnitResponseDto.from(await this.requireUnit(id));
  }

  async descendants(
    id: string,
  ): Promise<ReadonlyArray<OrganizationalUnitTreeResponseDto>> {
    const unit = await this.requireUnit(id);
    const all = await this.unitsRepository.findAll();
    return buildTree(all, unit.id);
  }

  async ancestors(
    id: string,
  ): Promise<ReadonlyArray<OrganizationalUnitResponseDto>> {
    const unit = await this.requireUnit(id);
    const chain: OrganizationalUnit[] = [];
    let current: OrganizationalUnit | null = unit;
    while (current) {
      chain.push(current);
      current = current.parentId
        ? await this.unitsRepository.findById(current.parentId)
        : null;
    }
    return chain.reverse().map(OrganizationalUnitResponseDto.from);
  }

  async create(
    dto: CreateOrganizationalUnitDto,
    actor: AuthenticatedUser,
  ): Promise<OrganizationalUnitResponseDto> {
    const parent = dto.parentId
      ? await this.requireUnit(dto.parentId)
      : null;
    try {
      const unit = await this.unitsRepository.insert({
        parentId: parent?.id ?? null,
        code: dto.code,
        name: dto.name,
        unitType: dto.type,
        hierarchyLevel: parent ? parent.hierarchyLevel + 1 : 0,
        hierarchyPath: childPath(parent?.hierarchyPath ?? null, dto.code),
        isActive: dto.isActive ?? true,
      });
      await this.auditLogsRepository.record({
        action: AuditAction.OrgUnitCreated,
        entityType: ORG_UNIT_ENTITY_TYPE,
        entityId: unit.id,
        performedBy: actor.id,
        ipAddress: null,
        userAgent: null,
        changes: { code: unit.code },
      });
      return OrganizationalUnitResponseDto.from(unit);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiException(ErrorCode.OrgUnitCodeAlreadyExists);
      }
      if (isOrgUnitCycle(error)) {
        throw new ApiException(ErrorCode.OrgUnitCycle);
      }
      throw error;
    }
  }

  async update(
    id: string,
    dto: UpdateOrganizationalUnitDto,
    actor: AuthenticatedUser,
  ): Promise<OrganizationalUnitResponseDto> {
    const unit = await this.requireUnit(id);
    let parentId = unit.parentId;
    let parent: OrganizationalUnit | null = unit.parentId
      ? await this.unitsRepository.findById(unit.parentId)
      : null;

    if (dto.parentId !== undefined) {
      if (dto.parentId === unit.id) {
        throw new ApiException(ErrorCode.OrgUnitCycle);
      }
      if (dto.parentId) {
        parent = await this.requireUnit(dto.parentId);
        if (await this.isAncestorOf(unit.id, parent.id)) {
          throw new ApiException(ErrorCode.OrgUnitCycle);
        }
        parentId = parent.id;
      } else {
        parent = null;
        parentId = null;
      }
    }

    const nextCode = dto.code ?? unit.code;
    const nextPath = childPath(parent?.hierarchyPath ?? null, nextCode);
    const nextLevel = parent ? parent.hierarchyLevel + 1 : 0;
    const pathChanged = nextPath !== unit.hierarchyPath;

    try {
      await this.unitsRepository.update(unit.id, {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.type !== undefined ? { unitType: dto.type } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(dto.code !== undefined ? { code: dto.code } : {}),
        ...(dto.parentId !== undefined ? { parentId } : {}),
        ...(pathChanged
          ? { hierarchyPath: nextPath, hierarchyLevel: nextLevel }
          : {}),
      });
      if (pathChanged && unit.hierarchyPath) {
        await this.unitsRepository.rewriteDescendantPaths(
          unit.hierarchyPath,
          nextPath,
          nextLevel - unit.hierarchyLevel,
        );
      }
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiException(ErrorCode.OrgUnitCodeAlreadyExists);
      }
      if (isOrgUnitCycle(error)) {
        throw new ApiException(ErrorCode.OrgUnitCycle);
      }
      throw error;
    }

    await this.auditLogsRepository.record({
      action: AuditAction.OrgUnitUpdated,
      entityType: ORG_UNIT_ENTITY_TYPE,
      entityId: unit.id,
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
      changes: { ...dto },
    });
    return OrganizationalUnitResponseDto.from(await this.requireUnit(id));
  }

  async remove(id: string, actor: AuthenticatedUser): Promise<null> {
    const unit = await this.requireUnit(id);
    const children = await this.unitsRepository.countActiveChildren(unit.id);
    if (children > 0) {
      throw new ApiException(ErrorCode.OrgUnitHasChildren);
    }
    const dependents = await this.unitsRepository.countCostCenters(unit.id);
    if (dependents > 0) {
      throw new ApiException(ErrorCode.HasDependentEntities);
    }
    await this.unitsRepository.deactivate(unit.id);
    await this.auditLogsRepository.record({
      action: AuditAction.OrgUnitDeleted,
      entityType: ORG_UNIT_ENTITY_TYPE,
      entityId: unit.id,
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
      changes: { code: unit.code },
    });
    return null;
  }

  private async requireUnit(id: string): Promise<OrganizationalUnit> {
    const unit = await this.unitsRepository.findById(id);
    if (!unit) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return unit;
  }

  private async isAncestorOf(
    ancestorId: string,
    nodeId: string,
  ): Promise<boolean> {
    let current = await this.unitsRepository.findById(nodeId);
    while (current?.parentId) {
      if (current.parentId === ancestorId) {
        return true;
      }
      current = await this.unitsRepository.findById(current.parentId);
    }
    return false;
  }
}
