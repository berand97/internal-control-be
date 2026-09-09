import { Inject, Injectable } from '@nestjs/common';
import type { NavigationDefinition } from '../../../common/authorization/navigation.registry.js';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import { isUniqueViolation } from '../../../common/exceptions/postgres-error.js';
import { CreateNavigationItemDto } from '../dto/create-navigation-item.dto.js';
import { UpdateNavigationItemDto } from '../dto/update-navigation-item.dto.js';
import { NavigationAdminItemResponseDto } from '../dto/responses/navigation-admin-item.response.dto.js';
import type { NavigationRepository } from '../repositories/navigation.repository.interface.js';

@Injectable()
export class NavigationService {
  private activeCache: ReadonlyArray<NavigationDefinition> | null = null;

  constructor(
    @Inject('NavigationRepository')
    private readonly repository: NavigationRepository,
  ) {}

  async listActiveDefinitions(): Promise<ReadonlyArray<NavigationDefinition>> {
    if (this.activeCache) {
      return this.activeCache;
    }
    const items = await this.repository.findActive();
    this.activeCache = items.map(NavigationAdminItemResponseDto.toDefinition);
    return this.activeCache;
  }

  async listAdmin(): Promise<ReadonlyArray<NavigationAdminItemResponseDto>> {
    const items = await this.repository.findAll();
    return items.map(NavigationAdminItemResponseDto.from);
  }

  async create(
    dto: CreateNavigationItemDto,
  ): Promise<NavigationAdminItemResponseDto> {
    try {
      const created = await this.repository.insert({
        module: dto.module,
        moduleLabel: dto.moduleLabel,
        resource: dto.resource,
        path: dto.path,
        label: dto.label,
        requiredAction: dto.requiredAction,
        sortOrder: dto.sortOrder ?? 0,
        isActive: dto.isActive ?? true,
      });
      this.invalidate();
      return NavigationAdminItemResponseDto.from(created);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiException(ErrorCode.NavigationPathAlreadyExists);
      }
      throw error;
    }
  }

  async update(
    id: string,
    dto: UpdateNavigationItemDto,
  ): Promise<NavigationAdminItemResponseDto> {
    const current = await this.repository.findById(id);
    if (!current) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    try {
      await this.repository.update(id, {
        ...(dto.module !== undefined ? { module: dto.module } : {}),
        ...(dto.moduleLabel !== undefined ? { moduleLabel: dto.moduleLabel } : {}),
        ...(dto.resource !== undefined ? { resource: dto.resource } : {}),
        ...(dto.path !== undefined ? { path: dto.path } : {}),
        ...(dto.label !== undefined ? { label: dto.label } : {}),
        ...(dto.requiredAction !== undefined
          ? { requiredAction: dto.requiredAction }
          : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiException(ErrorCode.NavigationPathAlreadyExists);
      }
      throw error;
    }
    const updated = await this.repository.findById(id);
    if (!updated) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    this.invalidate();
    return NavigationAdminItemResponseDto.from(updated);
  }

  async remove(id: string): Promise<null> {
    const removed = await this.repository.delete(id);
    if (!removed) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    this.invalidate();
    return null;
  }

  invalidate(): void {
    this.activeCache = null;
  }
}
