import { Inject, Injectable } from '@nestjs/common';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import { isUniqueViolation } from '../../../common/exceptions/postgres-error.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import type { AssetCategory } from '../../categories/entities/asset-category.entity.js';
import { CreateDynamicFieldDto } from '../dto/create-dynamic-field.dto.js';
import { DynamicFieldResponseDto } from '../dto/responses/dynamic-field.response.dto.js';
import { UpdateDynamicFieldDto } from '../dto/update-dynamic-field.dto.js';
import type { AssetCategoryField } from '../entities/asset-category-field.entity.js';
import type { DynamicFieldsRepository } from '../repositories/dynamic-fields.repository.interface.js';
import { assertFieldDefinition } from '../validation/field-definition.js';

const FIELD_ENTITY_TYPE = 'DYN_FIELD';

@Injectable()
export class DynamicFieldsService {
  constructor(
    @Inject('DynamicFieldsRepository')
    private readonly fieldsRepository: DynamicFieldsRepository,
    @Inject('AuditLogsRepository')
    private readonly auditLogsRepository: AuditLogsRepository,
  ) {}

  async list(
    categoryId: string,
  ): Promise<ReadonlyArray<DynamicFieldResponseDto>> {
    await this.requireCategory(categoryId);
    const fields = await this.fieldsRepository.findByCategory(categoryId);
    return fields.map((field) => DynamicFieldResponseDto.from(field, false));
  }

  async effectiveFields(
    categoryId: string,
  ): Promise<ReadonlyArray<DynamicFieldResponseDto>> {
    const chain = await this.ancestorChain(categoryId);
    const byCode = new Map<
      string,
      { field: AssetCategoryField; inherited: boolean }
    >();
    const selfId = categoryId;
    for (const category of chain) {
      const fields = await this.fieldsRepository.findByCategory(category.id);
      for (const field of fields) {
        if (!field.isActive) {
          continue;
        }
        byCode.set(field.code, {
          field,
          inherited: field.categoryId !== selfId,
        });
      }
    }
    return [...byCode.values()]
      .sort((left, right) => left.field.orderIndex - right.field.orderIndex)
      .map((item) => DynamicFieldResponseDto.from(item.field, item.inherited));
  }

  async create(
    categoryId: string,
    dto: CreateDynamicFieldDto,
    actor: AuthenticatedUser,
  ): Promise<DynamicFieldResponseDto> {
    await this.requireCategory(categoryId);
    const selectOptions = dto.selectOptions ?? null;
    const validationRules = dto.validationRules ?? null;
    assertFieldDefinition(dto.type, selectOptions, validationRules);
    try {
      const field = await this.fieldsRepository.insert({
        categoryId,
        code: dto.code,
        label: dto.label,
        type: dto.type,
        isRequired: dto.isRequired ?? false,
        defaultValue: dto.defaultValue ?? null,
        selectOptions,
        validationRules,
        orderIndex: dto.orderIndex ?? 0,
        isActive: true,
      });
      await this.auditLogsRepository.record({
        action: AuditAction.DynamicFieldCreated,
        entityType: FIELD_ENTITY_TYPE,
        entityId: field.id,
        performedBy: actor.id,
        ipAddress: null,
        userAgent: null,
        changes: { categoryId, code: field.code },
      });
      return DynamicFieldResponseDto.from(field);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiException(ErrorCode.DynamicFieldCodeExists);
      }
      throw error;
    }
  }

  async update(
    categoryId: string,
    id: string,
    dto: UpdateDynamicFieldDto,
    actor: AuthenticatedUser,
  ): Promise<DynamicFieldResponseDto> {
    await this.requireCategory(categoryId);
    const field = await this.requireField(id, categoryId);
    if (dto.type !== undefined && dto.type !== field.type) {
      throw new ApiException(ErrorCode.DynamicFieldTypeImmutable);
    }
    const selectOptions = dto.selectOptions ?? field.selectOptions;
    const validationRules = dto.validationRules ?? field.validationRules;
    assertFieldDefinition(field.type, selectOptions, validationRules);
    try {
      await this.fieldsRepository.update(field.id, {
        ...(dto.code !== undefined ? { code: dto.code } : {}),
        ...(dto.label !== undefined ? { label: dto.label } : {}),
        ...(dto.isRequired !== undefined ? { isRequired: dto.isRequired } : {}),
        ...(dto.defaultValue !== undefined
          ? { defaultValue: dto.defaultValue }
          : {}),
        ...(dto.selectOptions !== undefined
          ? { selectOptions: dto.selectOptions }
          : {}),
        ...(dto.validationRules !== undefined
          ? { validationRules: dto.validationRules }
          : {}),
        ...(dto.orderIndex !== undefined ? { orderIndex: dto.orderIndex } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiException(ErrorCode.DynamicFieldCodeExists);
      }
      throw error;
    }
    await this.auditLogsRepository.record({
      action: AuditAction.DynamicFieldUpdated,
      entityType: FIELD_ENTITY_TYPE,
      entityId: field.id,
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
      changes: { ...dto },
    });
    const updated = await this.requireField(id, categoryId);
    return DynamicFieldResponseDto.from(updated);
  }

  async remove(
    categoryId: string,
    id: string,
    actor: AuthenticatedUser,
  ): Promise<null> {
    await this.requireCategory(categoryId);
    const field = await this.requireField(id, categoryId);
    const usages = await this.fieldsRepository.countValues(field.id);
    if (usages > 0) {
      throw new ApiException(ErrorCode.DynamicFieldInUse);
    }
    await this.fieldsRepository.remove(field.id);
    await this.auditLogsRepository.record({
      action: AuditAction.DynamicFieldDeleted,
      entityType: FIELD_ENTITY_TYPE,
      entityId: field.id,
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
      changes: { code: field.code },
    });
    return null;
  }

  async deprecate(
    categoryId: string,
    id: string,
    actor: AuthenticatedUser,
  ): Promise<DynamicFieldResponseDto> {
    await this.requireCategory(categoryId);
    const field = await this.requireField(id, categoryId);
    await this.fieldsRepository.deprecate(field.id);
    await this.auditLogsRepository.record({
      action: AuditAction.DynamicFieldDeprecated,
      entityType: FIELD_ENTITY_TYPE,
      entityId: field.id,
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
      changes: { code: field.code },
    });
    return DynamicFieldResponseDto.from(await this.requireField(id, categoryId));
  }

  private async requireCategory(id: string): Promise<AssetCategory> {
    const category = await this.fieldsRepository.findCategoryById(id);
    if (!category) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return category;
  }

  private async requireField(
    id: string,
    categoryId: string,
  ): Promise<AssetCategoryField> {
    const field = await this.fieldsRepository.findById(id);
    if (!field || field.categoryId !== categoryId) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return field;
  }

  private async ancestorChain(
    categoryId: string,
  ): Promise<ReadonlyArray<AssetCategory>> {
    const chain: AssetCategory[] = [];
    let current: AssetCategory | null =
      await this.fieldsRepository.findCategoryById(categoryId);
    if (!current) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    while (current) {
      chain.unshift(current);
      current = current.parentId
        ? await this.fieldsRepository.findCategoryById(current.parentId)
        : null;
    }
    return chain;
  }
}
