import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, type EntityManager, IsNull } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import {
  isUniqueViolation,
  postgresMessage,
} from '../../../common/exceptions/postgres-error.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import {
  costCenterFilter,
  type ReadableCostCenterScope,
} from '../../roles/services/cost-center-scope.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import type { CategoriesRepository } from '../../categories/repositories/categories.repository.interface.js';
import type { CostCentersRepository } from '../../cost-centers/repositories/cost-centers.repository.interface.js';
import type { DynamicFieldResponseDto } from '../../dynamic-fields/dto/responses/dynamic-field.response.dto.js';
import { DynamicFieldsService } from '../../dynamic-fields/services/dynamic-fields.service.js';
import { validateDynamicValue } from '../../dynamic-fields/validation/field-definition.js';
import type { LocationsRepository } from '../../locations/repositories/locations.repository.interface.js';
import {
  coerceDynamicInput,
  fromCustomValueColumns,
  toCustomValueColumns,
} from '../domain/custom-values.js';
import { canTransitionStatus } from '../domain/status-transitions.js';
import { CreateAssetDto } from '../dto/create-asset.dto.js';
import { QueryAssetsDto } from '../dto/query-assets.dto.js';
import {
  AcquisitionTypeResponseDto,
  AssetBulkResultResponseDto,
  AssetImportErrorDto,
  AssetImportPreviewResponseDto,
  AssetListResponseDto,
  AssetMovementResponseDto,
  AssetResponseDto,
} from '../dto/responses/asset.response.dto.js';
import { UpdateAssetDto } from '../dto/update-asset.dto.js';
import { AssetIdentifier } from '../entities/asset-identifier.entity.js';
import type { Asset } from '../entities/asset.entity.js';
import {
  AssetIdentifierOrigin,
  AssetIdentifierType,
} from '../enums/asset-identifier.enum.js';
import { ImportMode } from '../enums/import-mode.enum.js';
import { MovementType } from '../enums/movement-type.enum.js';
import { OperationalStatus } from '../enums/operational-status.enum.js';
import { PhysicalCondition } from '../enums/physical-condition.enum.js';
import type { AssetsRepository } from '../repositories/assets.repository.interface.js';
import { parseAssetCsv } from '../csv/parse-asset-csv.js';
import {
  type AssetMovementSpec,
  AssetStateService,
} from './asset-state.service.js';
import { MovementsService } from '../../movements/services/movements.service.js';

const ENTITY_TYPE = 'ASSET';
const MAX_IMPORT_ROWS = 5000;
const IMPORT_TTL_MS = 30 * 60 * 1000;

@Injectable()
export class AssetsService {
  constructor(
    @Inject('AssetsRepository')
    private readonly assetsRepository: AssetsRepository,
    @Inject('CategoriesRepository')
    private readonly categoriesRepository: CategoriesRepository,
    @Inject('CostCentersRepository')
    private readonly costCentersRepository: CostCentersRepository,
    @Inject('LocationsRepository')
    private readonly locationsRepository: LocationsRepository,
    private readonly dynamicFieldsService: DynamicFieldsService,
    @Inject('AuditLogsRepository')
    private readonly auditLogsRepository: AuditLogsRepository,
    private readonly movementsService: MovementsService,
    private readonly dataSource: DataSource,
    private readonly assetState: AssetStateService,
  ) {}

  async listAcquisitionTypes(): Promise<
    ReadonlyArray<AcquisitionTypeResponseDto>
  > {
    const items = await this.assetsRepository.listAcquisitionTypes();
    return items.map((item) => ({
      id: item.id,
      code: item.code,
      name: item.name,
    }));
  }

  async list(
    query: QueryAssetsDto,
    scope: ReadableCostCenterScope,
  ): Promise<AssetListResponseDto> {
    const page = query.page;
    const pageSize = query.pageSize;
    const { items, total } = await this.assetsRepository.findPage({
      scopeCostCenterIds: costCenterFilter(scope),
      page,
      pageSize,
      sortBy: query.sortBy ?? 'createdAt',
      sortOrder: query.sortOrder === 'asc' ? 'ASC' : 'DESC',
      ...(query.q ? { q: query.q } : {}),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.costCenterId ? { costCenterId: query.costCenterId } : {}),
      ...(query.locationId ? { locationId: query.locationId } : {}),
      ...(query.operationalStatus
        ? { operationalStatus: query.operationalStatus }
        : {}),
      ...(query.acquiredFrom ? { acquiredFrom: query.acquiredFrom } : {}),
      ...(query.acquiredTo ? { acquiredTo: query.acquiredTo } : {}),
      ...(query.hasBarcode !== undefined ? { hasBarcode: query.hasBarcode } : {}),
      ...(query.dataQualityFlags?.length
        ? { dataQualityFlags: query.dataQualityFlags }
        : {}),
    });
    const identifiers = await this.assetsRepository.findIdentifiers(
      items.map((item) => item.id),
    );
    return {
      items: items.map((item) => AssetResponseDto.from(item, identifiers)),
      page,
      pageSize,
      total,
      hasNext: page * pageSize < total,
    };
  }

  /** Fuera de alcance responde igual que inexistente: 404 RESOURCE_NOT_FOUND. */
  async getById(
    id: string,
    scope: ReadableCostCenterScope,
  ): Promise<AssetResponseDto> {
    const asset = await this.assetsRepository.findById(
      id,
      costCenterFilter(scope),
    );
    if (!asset) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return this.toDetail(asset);
  }

  async create(
    dto: CreateAssetDto,
    actor: AuthenticatedUser,
  ): Promise<AssetResponseDto> {
    const asset = await this.persistNew(dto, actor, (created, manager) =>
      this.auditLogsRepository.record(
        {
          action: AuditAction.AssetCreated,
          entityType: ENTITY_TYPE,
          entityId: created.id,
          performedBy: actor.id,
          ipAddress: null,
          userAgent: null,
          changes: { internalCode: created.internalCode },
        },
        manager,
      ),
    );
    return this.toDetail(asset);
  }

  async bulkCreate(
    items: ReadonlyArray<CreateAssetDto>,
    mode: ImportMode,
    actor: AuthenticatedUser,
  ): Promise<AssetBulkResultResponseDto> {
    if (items.length > MAX_IMPORT_ROWS) {
      throw new ApiException(ErrorCode.AssetImportTooLarge);
    }
    const errors: AssetImportErrorDto[] = [];
    const created: Asset[] = [];
    for (const [index, item] of items.entries()) {
      try {
        created.push(await this.persistNew(item, actor));
      } catch (error) {
        if (mode === ImportMode.AllOrNothing) {
          throw this.asRowError(error, index + 1);
        }
        errors.push(this.toImportError(error, index + 1));
      }
    }
    if (created.length > 0) {
      await this.auditLogsRepository.record({
        action: AuditAction.AssetImported,
        entityType: ENTITY_TYPE,
        entityId: created[0]?.id ?? actor.id,
        performedBy: actor.id,
        ipAddress: null,
        userAgent: null,
        changes: { createdCount: created.length, errorCount: errors.length },
      });
    }
    const createdIdentifiers = await this.assetsRepository.findIdentifiers(
      created.map((item) => item.id),
    );
    return {
      createdCount: created.length,
      errors,
      items: created.map((item) => AssetResponseDto.from(item, createdIdentifiers)),
    };
  }

  async previewImport(
    csv: string,
    filename: string,
    actor: AuthenticatedUser,
  ): Promise<AssetImportPreviewResponseDto> {
    const rows = parseAssetCsv(csv);
    if (rows.length === 0) {
      throw new ApiException(ErrorCode.InvalidCsv);
    }
    if (rows.length > MAX_IMPORT_ROWS) {
      throw new ApiException(ErrorCode.AssetImportTooLarge);
    }
    const dtos: CreateAssetDto[] = [];
    const errors: AssetImportErrorDto[] = [];
    for (const row of rows) {
      try {
        dtos.push(await this.csvRowToDto(row));
      } catch (error) {
        errors.push(this.toImportError(error, row.rowNumber));
      }
    }
    const batch = await this.assetsRepository.saveImportBatch({
      filename,
      payload: dtos,
      expiresAt: new Date(Date.now() + IMPORT_TTL_MS),
      createdBy: actor.id,
    });
    return {
      previewId: batch.id,
      expiresAt: batch.expiresAt,
      total: rows.length,
      validCount: dtos.length,
      errorCount: errors.length,
      errors,
    };
  }

  async commitImport(
    previewId: string,
    mode: ImportMode,
    actor: AuthenticatedUser,
  ): Promise<AssetBulkResultResponseDto> {
    const batch = await this.assetsRepository.findImportBatch(previewId);
    if (!batch || batch.committedAt) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    if (batch.expiresAt.getTime() < Date.now()) {
      throw new ApiException(ErrorCode.AssetImportExpired);
    }
    if (!Array.isArray(batch.payload)) {
      throw new ApiException(ErrorCode.InvalidCsv);
    }
    const result = await this.bulkCreate(
      batch.payload as CreateAssetDto[],
      mode,
      actor,
    );
    await this.assetsRepository.markImportCommitted(previewId);
    return result;
  }

  async update(
    id: string,
    dto: UpdateAssetDto,
    actor: AuthenticatedUser,
  ): Promise<AssetResponseDto> {
    const asset = await this.requireMutable(id);
    if (dto.internalCode !== undefined && dto.internalCode !== asset.internalCode) {
      throw new ApiException(ErrorCode.AssetCannotBeModified);
    }
    await this.assertNotUnderInventory(asset.id);
    if (dto.locationId) {
      await this.requireLocation(dto.locationId);
    }
    if (dto.costCenterId && dto.costCenterId !== asset.costCenterId) {
      throw new ApiException(ErrorCode.AssetCannotBeModified);
    }
    const nextCategoryId = dto.categoryId ?? asset.categoryId;
    const category = await this.requireCategory(nextCategoryId);
    if (category.requiresSerialNumber && !(dto.serialNumber ?? asset.serialNumber)) {
      throw new ApiException(ErrorCode.AssetSerialRequired);
    }
    const categoryChanged = nextCategoryId !== asset.categoryId;
    const customWrites =
      dto.customValues || categoryChanged
        ? this.buildCustomWrites(
            await this.dynamicFieldsService.effectiveFields(nextCategoryId),
            {
              ...(categoryChanged ? await this.currentCustomValues(asset.id) : {}),
              ...(dto.customValues ?? {}),
            },
          )
        : null;
    const barcode = dto.barcode !== undefined ? dto.barcode || null : undefined;
    const movement = editMovement(asset, dto);
    let updated: Asset;
    try {
      updated = await this.assetState.apply({
        assetId: asset.id,
        actorId: actor.id,
        patch: {
          ...(categoryChanged ? { categoryId: nextCategoryId } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          ...(dto.model !== undefined ? { model: dto.model } : {}),
          ...(barcode !== undefined ? { barcode } : {}),
          ...(dto.serialNumber !== undefined
            ? { serialNumber: dto.serialNumber || null }
            : {}),
          ...(dto.locationId !== undefined ? { locationId: dto.locationId } : {}),
          ...(dto.responsibleId !== undefined
            ? { responsibleId: dto.responsibleId }
            : {}),
          ...(dto.physicalCondition !== undefined
            ? { physicalCondition: dto.physicalCondition }
            : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          ...(dto.insurancePolicyNumber !== undefined
            ? { insurancePolicyNumber: dto.insurancePolicyNumber }
            : {}),
        },
        guard: assertMutable,
        ...(movement ? { movement } : {}),
        audit: { action: AuditAction.AssetUpdated, changes: { ...dto } },
        alsoWrite: async (manager, current) => {
          if (customWrites) {
            await this.assetsRepository.replaceCustomValues(
              asset.id,
              customWrites,
              manager,
            );
          }
          if (barcode !== undefined && barcode !== current.barcode) {
            await this.replaceLegacyCode(current, barcode, actor.id, manager);
          }
        },
      });
    } catch (error) {
      this.rethrowUnique(error);
    }
    return this.toDetail(updated);
  }

  async changeStatus(
    id: string,
    status: OperationalStatus,
    reason: string,
    actor: AuthenticatedUser,
  ): Promise<AssetResponseDto> {
    const asset = await this.requireMutable(id);
    await this.assertNotUnderInventory(asset.id);
    if (status === OperationalStatus.WrittenOff) {
      throw new ApiException(ErrorCode.AssetInvalidStatusTransition);
    }
    if (!canTransitionStatus(asset.operationalStatus, status)) {
      throw new ApiException(ErrorCode.AssetInvalidStatusTransition);
    }
    const movementType =
      status === OperationalStatus.InMaintenance
        ? MovementType.MaintenanceIn
        : asset.operationalStatus === OperationalStatus.InMaintenance
          ? MovementType.MaintenanceOut
          : MovementType.ConditionChange;
    const updated = await this.assetState.apply({
      assetId: asset.id,
      actorId: actor.id,
      patch: { operationalStatus: status },
      guard: (current) => {
        assertMutable(current);
        if (
          current.operationalStatus !== asset.operationalStatus ||
          !canTransitionStatus(current.operationalStatus, status)
        ) {
          throw new ApiException(ErrorCode.AssetInvalidStatusTransition);
        }
      },
      movement: { type: movementType, reason, documentReference: null },
      audit: {
        action: AuditAction.AssetStatusChanged,
        changes: { from: asset.operationalStatus, to: status, reason },
      },
    });
    return this.toDetail(updated);
  }

  async writeOff(
    id: string,
    dto: { reason: string; documentReference: string; writtenOffAt?: string },
    actor: AuthenticatedUser,
  ): Promise<AssetResponseDto> {
    const asset = await this.requireMutable(id);
    await this.assertNotUnderInventory(asset.id);
    await this.assertNoActiveLoan(asset.id);
    const writtenOffAt =
      dto.writtenOffAt ?? new Date().toISOString().slice(0, 10);
    const updated = await this.assetState.apply({
      assetId: asset.id,
      actorId: actor.id,
      patch: {
        operationalStatus: OperationalStatus.WrittenOff,
        writtenOffAt,
        writeOffReason: dto.reason,
        writeOffDocument: dto.documentReference,
        writeOffApprovedBy: actor.id,
      },
      guard: assertMutable,
      movement: {
        type: MovementType.WriteOff,
        reason: dto.reason,
        documentReference: dto.documentReference,
      },
      audit: {
        action: AuditAction.AssetWrittenOff,
        changes: { documentReference: dto.documentReference },
      },
    });
    return this.toDetail(updated);
  }

  async reassignLocation(
    id: string,
    locationId: string,
    reason: string | undefined,
    actor: AuthenticatedUser,
  ): Promise<AssetResponseDto> {
    const asset = await this.requireAsset(id);
    assertNotWrittenOff(asset);
    await this.assertNotUnderInventory(asset.id);
    await this.requireLocation(locationId);
    const updated = await this.assetState.apply({
      assetId: asset.id,
      actorId: actor.id,
      patch: { locationId },
      guard: assertNotWrittenOff,
      movement: {
        type: MovementType.Relocation,
        reason: reason ?? null,
        documentReference: null,
      },
      audit: {
        action: AuditAction.AssetRelocated,
        changes: { from: asset.locationId, to: locationId },
      },
    });
    return this.toDetail(updated);
  }

  async reassignCostCenter(
    id: string,
    costCenterId: string,
    documentReference: string,
    reason: string | undefined,
    actor: AuthenticatedUser,
  ): Promise<AssetResponseDto> {
    const asset = await this.requireMutable(id);
    await this.assertNotUnderInventory(asset.id);
    await this.assertNoActiveLoan(asset.id);
    await this.requireCostCenter(costCenterId);
    const updated = await this.assetState.apply({
      assetId: asset.id,
      actorId: actor.id,
      patch: { costCenterId },
      guard: assertMutable,
      movement: {
        type: MovementType.Transfer,
        reason: reason ?? null,
        documentReference,
      },
      audit: {
        action: AuditAction.AssetTransferred,
        changes: { from: asset.costCenterId, to: costCenterId },
      },
    });
    return this.toDetail(updated);
  }

  private async currentCustomValues(
    assetId: string,
  ): Promise<Record<string, unknown>> {
    const rows = await this.assetsRepository.findCustomValues(assetId);
    return Object.fromEntries(
      rows.map((item) => [item.code, fromCustomValueColumns(item.type, item.row)]),
    );
  }

  private async replaceLegacyCode(
    current: Asset,
    barcode: string | null,
    actorId: string,
    manager: EntityManager,
  ): Promise<void> {
    if (current.barcode) {
      await manager.getRepository(AssetIdentifier).update(
        {
          assetId: current.id,
          identifierType: AssetIdentifierType.LegacyCode,
          value: current.barcode,
          validTo: IsNull(),
        },
        { validTo: new Date() },
      );
    }
    if (barcode) {
      await this.assetsRepository.insertIdentifiers(
        current.id,
        [
          {
            type: AssetIdentifierType.LegacyCode,
            value: barcode,
            origin: AssetIdentifierOrigin.Manual,
          },
        ],
        actorId,
        manager,
      );
    }
  }

  private async persistNew(
    dto: CreateAssetDto,
    actor: AuthenticatedUser,
    afterInsert?: (asset: Asset, manager: EntityManager) => Promise<void>,
  ): Promise<Asset> {
    const category = await this.requireCategory(dto.categoryId);
    await this.requireCostCenter(dto.costCenterId);
    if (dto.locationId) {
      await this.requireLocation(dto.locationId);
    }
    const acquisitionType = await this.assetsRepository.findAcquisitionTypeById(
      dto.acquisitionTypeId,
    );
    if (!acquisitionType) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    if (category.requiresSerialNumber && !dto.serialNumber) {
      throw new ApiException(ErrorCode.AssetSerialRequired);
    }
    if (category.requiresPhoto && !dto.photoUrl) {
      throw new ApiException(ErrorCode.AssetPhotoRequired);
    }
    const fields = await this.dynamicFieldsService.effectiveFields(
      dto.categoryId,
    );
    const writes = this.buildCustomWrites(fields, dto.customValues ?? {});
    const year = new Date(dto.acquisitionDate).getFullYear();
    try {
      return await this.dataSource.transaction(async (manager) => {
        const internalCode =
          dto.internalCode ??
          (await this.assetsRepository.nextInternalCode(year, manager));
        const asset = await this.assetsRepository.insert({
          internalCode,
          barcode: dto.barcode || null,
          serialNumber: dto.serialNumber || null,
          description: dto.description,
          model: dto.model ?? null,
          categoryId: dto.categoryId,
          acquisitionTypeId: dto.acquisitionTypeId,
          acquisitionDate: dto.acquisitionDate.slice(0, 10),
          acquisitionDocument: dto.acquisitionDocument ?? null,
          acquisitionPrice: String(dto.acquisitionPrice ?? 0),
          currency: 'COP',
          operationalStatus: OperationalStatus.InUse,
          physicalCondition: dto.physicalCondition ?? PhysicalCondition.New,
          costCenterId: dto.costCenterId,
          locationId: dto.locationId ?? null,
          responsibleId: dto.responsibleId ?? null,
          depreciationMethod: category.depreciationMethod,
          usefulLifeYears: category.depreciationYears,
          salvageValue: '0',
          notes: dto.notes ?? null,
          createdBy: actor.id,
        }, manager);
        await this.assetsRepository.insertIdentifiers(
          asset.id,
          [
            {
              type: AssetIdentifierType.VisibleCode,
              value: internalCode,
              origin: dto.internalCode
                ? AssetIdentifierOrigin.Manual
                : AssetIdentifierOrigin.Generated,
            },
            {
              type: AssetIdentifierType.OpaqueId,
              value: randomUUID(),
              origin: AssetIdentifierOrigin.Generated,
            },
            ...(dto.barcode
              ? [
                  {
                    type: AssetIdentifierType.LegacyCode,
                    value: dto.barcode,
                    origin: AssetIdentifierOrigin.Manual,
                  },
                ]
              : []),
          ],
          actor.id,
          manager,
        );
        await this.assetsRepository.replaceCustomValues(asset.id, writes, manager);
        if (dto.photoUrl) {
          await this.assetsRepository.insertPhoto(
            asset.id,
            dto.photoUrl,
            actor.id,
            manager,
          );
        }
        await this.movementsService.record({
          assetId: asset.id,
          movementType: MovementType.Registration,
          fromCostCenterId: null,
          fromLocationId: null,
          fromResponsibleId: null,
          fromOperationalStatus: null,
          fromPhysicalCondition: null,
          toCostCenterId: asset.costCenterId,
          toLocationId: asset.locationId,
          toResponsibleId: asset.responsibleId,
          toOperationalStatus: asset.operationalStatus,
          toPhysicalCondition: asset.physicalCondition,
          requestedBy: actor.id,
          authorizedBy: actor.id,
          reason: 'Alta de activo',
          documentReference: dto.acquisitionDocument ?? null,
        }, manager);
        await afterInsert?.(asset, manager);
        return asset;
      });
    } catch (error) {
      this.rethrowUnique(error);
    }
  }

  private buildCustomWrites(
    fields: ReadonlyArray<DynamicFieldResponseDto>,
    values: Record<string, unknown>,
  ) {
    const writes = [];
    for (const field of fields) {
      const raw = values[field.code];
      const coerced = coerceDynamicInput(field.type, raw);
      if (field.isRequired && (coerced === null || coerced === undefined)) {
        throw new ApiException(
          ErrorCode.AssetMissingCustomField,
          undefined,
          [{ field: field.code, message: field.label }],
        );
      }
      if (coerced === null || coerced === undefined) {
        continue;
      }
      if (
        !validateDynamicValue(
          field.type,
          coerced,
          field.selectOptions ? [...field.selectOptions] : null,
          field.validationRules,
        )
      ) {
        throw new ApiException(
          ErrorCode.AssetInvalidDynamicValue,
          undefined,
          [{ field: field.code, message: field.label }],
        );
      }
      writes.push({
        fieldId: field.id,
        columns: toCustomValueColumns(field.type, coerced),
      });
    }
    return writes;
  }

  private async csvRowToDto(
    row: Awaited<ReturnType<typeof parseAssetCsv>>[number],
  ): Promise<CreateAssetDto> {
    const category = await this.assetsRepository.findCategoryCode(
      row.categoryCode,
    );
    const costCenter = await this.assetsRepository.findCostCenterByExternalCode(
      row.costCenterCode,
    );
    const acquisitionType =
      await this.assetsRepository.findAcquisitionTypeByCode(
        row.acquisitionTypeCode,
      );
    if (!category || !costCenter || !acquisitionType) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    let locationId: string | undefined;
    if (row.locationCode) {
      const location = await this.assetsRepository.findLocationByCode(
        row.locationCode,
      );
      if (!location) {
        throw new ApiException(ErrorCode.ResourceNotFound);
      }
      locationId = location.id;
    }
    const price = row.acquisitionPrice ? Number(row.acquisitionPrice) : undefined;
    return {
      description: row.description,
      categoryId: category.id,
      costCenterId: costCenter.id,
      acquisitionTypeId: acquisitionType.id,
      acquisitionDate: row.acquisitionDate,
      ...(row.internalCode ? { internalCode: row.internalCode } : {}),
      ...(locationId ? { locationId } : {}),
      ...(row.serialNumber ? { serialNumber: row.serialNumber } : {}),
      ...(row.barcode ? { barcode: row.barcode } : {}),
      ...(row.model ? { model: row.model } : {}),
      ...(row.photoUrl ? { photoUrl: row.photoUrl } : {}),
      ...(row.notes ? { notes: row.notes } : {}),
      ...(price !== undefined && !Number.isNaN(price)
        ? { acquisitionPrice: price }
        : {}),
      ...(Object.keys(row.customValues).length > 0
        ? { customValues: row.customValues }
        : {}),
    };
  }

  private async toDetail(asset: Asset): Promise<AssetResponseDto> {
    const [category, costCenter, location, custom, movements, loans, identifiers] =
      await Promise.all([
        this.assetsRepository.findNamedCategory(asset.categoryId),
        this.assetsRepository.findNamedCostCenter(asset.costCenterId),
        asset.locationId
          ? this.assetsRepository.findNamedLocation(asset.locationId)
          : Promise.resolve(null),
        this.assetsRepository.findCustomValues(asset.id),
        this.assetsRepository.findRecentMovements(asset.id, 10),
        this.assetsRepository.findActiveLoans(asset.id),
        this.assetsRepository.findIdentifiers([asset.id]),
      ]);
    return AssetResponseDto.from(asset, identifiers, {
      ...(category ? { category } : {}),
      ...(costCenter ? { costCenter } : {}),
      location: location,
      customValues: custom.map((item) => ({
        fieldId: item.row.fieldId,
        code: item.code,
        label: item.label,
        type: item.type,
        value: fromCustomValueColumns(item.type, item.row),
      })),
      movements: movements.map(
        (item): AssetMovementResponseDto => ({
          id: item.id,
          movementType: item.movementType,
          reason: item.reason,
          documentReference: item.documentReference,
          executedAt: item.executedAt,
          fromOperationalStatus: item.fromOperationalStatus,
          toOperationalStatus: item.toOperationalStatus,
          fromLocationId: item.fromLocationId,
          toLocationId: item.toLocationId,
          fromCostCenterId: item.fromCostCenterId,
          toCostCenterId: item.toCostCenterId,
        }),
      ),
      activeLoans: loans,
    });
  }

  private async requireAsset(id: string): Promise<Asset> {
    const asset = await this.assetsRepository.findById(id);
    if (!asset) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return asset;
  }

  private async requireMutable(id: string): Promise<Asset> {
    const asset = await this.requireAsset(id);
    assertMutable(asset);
    return asset;
  }

  private async requireCategory(id: string) {
    const category = await this.categoriesRepository.findById(id);
    if (!category || !category.isActive) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return category;
  }

  private async requireCostCenter(id: string) {
    const center = await this.costCentersRepository.findActiveById(id);
    if (!center || !center.acceptsAssets) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return center;
  }

  private async requireLocation(id: string) {
    const location = await this.locationsRepository.findById(id);
    if (!location || !location.isActive) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return location;
  }

  private async assertNoActiveLoan(assetId: string): Promise<void> {
    const count = await this.assetsRepository.countActiveLoans(assetId);
    if (count > 0) {
      throw new ApiException(ErrorCode.AssetHasActiveLoan);
    }
  }

  private async assertNotUnderInventory(assetId: string): Promise<void> {
    const count = await this.assetsRepository.countOpenInventories(assetId);
    if (count > 0) {
      throw new ApiException(ErrorCode.AssetUnderInventory);
    }
  }

  private rethrowUnique(error: unknown): never {
    if (isUniqueViolation(error)) {
      const message = postgresMessage(error);
      if (message.includes('barcode')) {
        throw new ApiException(ErrorCode.AssetBarcodeAlreadyExists);
      }
      throw new ApiException(ErrorCode.AssetInternalCodeAlreadyExists);
    }
    throw error;
  }

  private asRowError(error: unknown, row: number): ApiException {
    const mapped = this.toImportError(error, row);
    return new ApiException(
      ErrorCode.ValidationFailed,
      mapped.message,
      [{ field: `row.${row}`, message: mapped.message }],
    );
  }

  private toImportError(error: unknown, row: number): AssetImportErrorDto {
    if (error instanceof ApiException) {
      return { row, message: error.message, code: error.code };
    }
    return {
      row,
      message: 'No se pudo importar la fila',
      code: ErrorCode.InternalError,
    };
  }
}

const assertNotWrittenOff = (asset: Asset): void => {
  if (asset.operationalStatus === OperationalStatus.WrittenOff) {
    throw new ApiException(ErrorCode.AssetAlreadyWrittenOff);
  }
};

const assertMutable = (asset: Asset): void => {
  assertNotWrittenOff(asset);
  if (asset.operationalStatus === OperationalStatus.OnLoan) {
    throw new ApiException(ErrorCode.AssetCannotBeModified);
  }
};

const editMovement = (
  asset: Asset,
  dto: UpdateAssetDto,
): AssetMovementSpec | null => {
  const changed = <T>(next: T | undefined, current: T): boolean =>
    next !== undefined && next !== current;
  const type = changed(dto.responsibleId, asset.responsibleId)
    ? MovementType.Assignment
    : changed(dto.locationId, asset.locationId)
      ? MovementType.Relocation
      : changed(dto.physicalCondition, asset.physicalCondition)
        ? MovementType.ConditionChange
        : null;
  return type
    ? { type, reason: 'Edición del activo', documentReference: null }
    : null;
};
