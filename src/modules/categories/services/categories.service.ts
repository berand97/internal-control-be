import { Inject, Injectable } from '@nestjs/common';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import {
  isCategoryCycle,
  isUniqueViolation,
} from '../../../common/exceptions/postgres-error.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import { CreateCategoryDto } from '../dto/create-category.dto.js';
import { QueryCategoriesDto } from '../dto/query-categories.dto.js';
import { CategoryTreeResponseDto } from '../dto/responses/category-tree.response.dto.js';
import { CategoryResponseDto } from '../dto/responses/category.response.dto.js';
import { UpdateCategoryDto } from '../dto/update-category.dto.js';
import type { AssetCategory } from '../entities/asset-category.entity.js';
import { DepreciationMethod } from '../enums/depreciation-method.enum.js';
import type { CategoriesRepository } from '../repositories/categories.repository.interface.js';

const CATEGORY_ENTITY_TYPE = 'CATEGORY';

const toPathSegment = (code: string): string => code.toLowerCase();

const childPath = (parentPath: string | null, code: string): string =>
  parentPath ? `${parentPath}/${toPathSegment(code)}` : `/${toPathSegment(code)}`;

const buildTree = (
  items: ReadonlyArray<AssetCategory>,
  parentId: string | null,
): ReadonlyArray<CategoryTreeResponseDto> =>
  items
    .filter((item) => item.parentId === parentId)
    .map((item) => CategoryTreeResponseDto.from(item, buildTree(items, item.id)));

@Injectable()
export class CategoriesService {
  constructor(
    @Inject('CategoriesRepository')
    private readonly categoriesRepository: CategoriesRepository,
    @Inject('AuditLogsRepository')
    private readonly auditLogsRepository: AuditLogsRepository,
  ) {}

  async list(
    query: QueryCategoriesDto,
  ): Promise<ReadonlyArray<CategoryResponseDto>> {
    const items = await this.categoriesRepository.findAll({
      ...(query.q ? { q: query.q } : {}),
      ...(query.parentId ? { parentId: query.parentId } : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
    });
    return items.map(CategoryResponseDto.from);
  }

  async tree(): Promise<ReadonlyArray<CategoryTreeResponseDto>> {
    const items = await this.categoriesRepository.findAll({});
    return buildTree(items, null);
  }

  async getById(id: string): Promise<CategoryResponseDto> {
    return CategoryResponseDto.from(await this.requireCategory(id));
  }

  async create(
    dto: CreateCategoryDto,
    actor: AuthenticatedUser,
  ): Promise<CategoryResponseDto> {
    const parent = dto.parentId
      ? await this.requireCategory(dto.parentId)
      : null;
    try {
      const category = await this.categoriesRepository.insert({
        parentId: parent?.id ?? null,
        code: dto.code,
        name: dto.name,
        description: dto.description ?? null,
        depreciationYears: dto.depreciationYears ?? null,
        depreciationMethod:
          dto.depreciationMethod ?? DepreciationMethod.StraightLine,
        requiresSerialNumber: dto.requiresSerialNumber ?? false,
        requiresPhoto: dto.requiresPhoto ?? true,
        hierarchyPath: childPath(parent?.hierarchyPath ?? null, dto.code),
        isActive: dto.isActive ?? true,
      });
      await this.auditLogsRepository.record({
        action: AuditAction.CategoryCreated,
        entityType: CATEGORY_ENTITY_TYPE,
        entityId: category.id,
        performedBy: actor.id,
        ipAddress: null,
        userAgent: null,
        changes: { code: category.code },
      });
      return CategoryResponseDto.from(category);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiException(ErrorCode.CategoryCodeAlreadyExists);
      }
      if (isCategoryCycle(error)) {
        throw new ApiException(ErrorCode.CategoryCycle);
      }
      throw error;
    }
  }

  async update(
    id: string,
    dto: UpdateCategoryDto,
    actor: AuthenticatedUser,
  ): Promise<CategoryResponseDto> {
    const category = await this.requireCategory(id);
    let parent: AssetCategory | null = category.parentId
      ? await this.categoriesRepository.findById(category.parentId)
      : null;
    let parentId = category.parentId;

    if (dto.parentId !== undefined) {
      if (dto.parentId === category.id) {
        throw new ApiException(ErrorCode.CategoryCycle);
      }
      if (dto.parentId) {
        parent = await this.requireCategory(dto.parentId);
        if (await this.isAncestorOf(category.id, parent.id)) {
          throw new ApiException(ErrorCode.CategoryCycle);
        }
        parentId = parent.id;
      } else {
        parent = null;
        parentId = null;
      }
    }

    const nextCode = dto.code ?? category.code;
    const nextPath = childPath(parent?.hierarchyPath ?? null, nextCode);
    const pathChanged = nextPath !== category.hierarchyPath;

    try {
      await this.categoriesRepository.update(category.id, {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description }
          : {}),
        ...(dto.depreciationYears !== undefined
          ? { depreciationYears: dto.depreciationYears }
          : {}),
        ...(dto.depreciationMethod !== undefined
          ? { depreciationMethod: dto.depreciationMethod }
          : {}),
        ...(dto.requiresSerialNumber !== undefined
          ? { requiresSerialNumber: dto.requiresSerialNumber }
          : {}),
        ...(dto.requiresPhoto !== undefined
          ? { requiresPhoto: dto.requiresPhoto }
          : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(dto.code !== undefined ? { code: dto.code } : {}),
        ...(dto.parentId !== undefined ? { parentId } : {}),
        ...(pathChanged ? { hierarchyPath: nextPath } : {}),
      });
      if (pathChanged && category.hierarchyPath) {
        await this.categoriesRepository.rewriteDescendantPaths(
          category.hierarchyPath,
          nextPath,
        );
      }
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiException(ErrorCode.CategoryCodeAlreadyExists);
      }
      if (isCategoryCycle(error)) {
        throw new ApiException(ErrorCode.CategoryCycle);
      }
      throw error;
    }

    await this.auditLogsRepository.record({
      action: AuditAction.CategoryUpdated,
      entityType: CATEGORY_ENTITY_TYPE,
      entityId: category.id,
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
      changes: { ...dto },
    });
    return CategoryResponseDto.from(await this.requireCategory(id));
  }

  async remove(id: string, actor: AuthenticatedUser): Promise<null> {
    const category = await this.requireCategory(id);
    const children = await this.categoriesRepository.countActiveChildren(
      category.id,
    );
    if (children > 0) {
      throw new ApiException(ErrorCode.CategoryHasChildren);
    }
    const assets = await this.categoriesRepository.countAssets(category.id);
    if (assets > 0) {
      throw new ApiException(ErrorCode.AssetCategoryHasAssets);
    }
    await this.categoriesRepository.deactivate(category.id);
    await this.auditLogsRepository.record({
      action: AuditAction.CategoryDeleted,
      entityType: CATEGORY_ENTITY_TYPE,
      entityId: category.id,
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
      changes: { code: category.code },
    });
    return null;
  }

  private async requireCategory(id: string): Promise<AssetCategory> {
    const category = await this.categoriesRepository.findById(id);
    if (!category) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return category;
  }

  private async isAncestorOf(
    ancestorId: string,
    nodeId: string,
  ): Promise<boolean> {
    let current = await this.categoriesRepository.findById(nodeId);
    while (current?.parentId) {
      if (current.parentId === ancestorId) {
        return true;
      }
      current = await this.categoriesRepository.findById(current.parentId);
    }
    return false;
  }
}
