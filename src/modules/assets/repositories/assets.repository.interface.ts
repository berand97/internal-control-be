import type { EntityManager } from 'typeorm';
import type { DepreciationMethod } from '../../categories/enums/depreciation-method.enum.js';
import type { DynamicFieldType } from '../../dynamic-fields/enums/dynamic-field-type.enum.js';
import type { AcquisitionType } from '../entities/acquisition-type.entity.js';
import type { AssetCustomValue } from '../entities/asset-custom-value.entity.js';
import type { AssetImportBatch } from '../entities/asset-import-batch.entity.js';
import type { AssetMovement } from '../entities/asset-movement.entity.js';
import type { Asset } from '../entities/asset.entity.js';
import type { MovementType } from '../enums/movement-type.enum.js';
import type { OperationalStatus } from '../enums/operational-status.enum.js';
import type { PhysicalCondition } from '../enums/physical-condition.enum.js';
import type { CustomValueColumns } from '../domain/custom-values.js';
import type {
  AssetIdentifierOrigin,
  AssetIdentifierType,
} from '../enums/asset-identifier.enum.js';

export interface CreateAssetRecord {
  readonly internalCode: string;
  readonly barcode: string | null;
  readonly serialNumber: string | null;
  readonly description: string;
  readonly model: string | null;
  readonly categoryId: string;
  readonly acquisitionTypeId: string;
  readonly acquisitionDate: string;
  readonly acquisitionDocument: string | null;
  readonly acquisitionPrice: string;
  readonly currency: string;
  readonly operationalStatus: OperationalStatus;
  readonly physicalCondition: PhysicalCondition;
  readonly costCenterId: string;
  readonly locationId: string | null;
  readonly responsibleId: string | null;
  readonly depreciationMethod: DepreciationMethod;
  readonly usefulLifeYears: number | null;
  readonly salvageValue: string;
  readonly notes: string | null;
  readonly createdBy: string;
}

export interface UpdateAssetRecord {
  readonly description?: string;
  readonly model?: string | null;
  readonly barcode?: string | null;
  readonly serialNumber?: string | null;
  readonly locationId?: string | null;
  readonly costCenterId?: string;
  readonly responsibleId?: string | null;
  readonly physicalCondition?: PhysicalCondition;
  readonly operationalStatus?: OperationalStatus;
  readonly notes?: string | null;
  readonly insurancePolicyNumber?: string | null;
  readonly writtenOffAt?: string | null;
  readonly writeOffReason?: string | null;
  readonly writeOffDocument?: string | null;
  readonly writeOffApprovedBy?: string | null;
  readonly qrToken?: string | null;
  readonly qrTokenVersion?: number;
  readonly qrSignedAt?: Date | null;
  readonly qrSignedBy?: string | null;
  readonly updatedBy?: string | null;
}

export interface AssetSearchFilters {
  readonly q?: string;
  readonly categoryId?: string;
  readonly costCenterId?: string;
  readonly locationId?: string;
  readonly operationalStatus?: OperationalStatus;
  readonly acquiredFrom?: string;
  readonly acquiredTo?: string;
  readonly hasBarcode?: boolean;
  readonly page: number;
  readonly pageSize: number;
  readonly sortBy: string;
  readonly sortOrder: 'ASC' | 'DESC';
}

export interface CreateMovementRecord {
  readonly assetId: string;
  readonly movementType: MovementType;
  readonly fromCostCenterId: string | null;
  readonly fromLocationId: string | null;
  readonly fromResponsibleId: string | null;
  readonly fromOperationalStatus: OperationalStatus | null;
  readonly fromPhysicalCondition: PhysicalCondition | null;
  readonly toCostCenterId: string | null;
  readonly toLocationId: string | null;
  readonly toResponsibleId: string | null;
  readonly toOperationalStatus: OperationalStatus | null;
  readonly toPhysicalCondition: PhysicalCondition | null;
  readonly requestedBy: string | null;
  readonly authorizedBy: string | null;
  readonly reason: string | null;
  readonly documentReference: string | null;
}

export interface AssetIdentifierWrite {
  readonly type: AssetIdentifierType;
  readonly value: string;
  readonly origin: AssetIdentifierOrigin;
}

export interface CustomValueWrite {
  readonly fieldId: string;
  readonly columns: CustomValueColumns;
}

export interface NamedRef {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export interface CustomValueWithField {
  readonly row: AssetCustomValue;
  readonly code: string;
  readonly label: string;
  readonly type: DynamicFieldType;
}

export interface AssetsRepository {
  findPage(
    filters: AssetSearchFilters,
  ): Promise<{ items: ReadonlyArray<Asset>; total: number }>;
  findById(id: string): Promise<Asset | null>;
  findByInternalCode(code: string): Promise<Asset | null>;
  insert(record: CreateAssetRecord, manager?: EntityManager): Promise<Asset>;
  update(
    id: string,
    record: UpdateAssetRecord,
    manager?: EntityManager,
  ): Promise<void>;
  nextInternalCode(year: number, manager?: EntityManager): Promise<string>;
  replaceCustomValues(
    assetId: string,
    values: ReadonlyArray<CustomValueWrite>,
    manager?: EntityManager,
  ): Promise<void>;
  insertIdentifiers(
    assetId: string,
    identifiers: ReadonlyArray<AssetIdentifierWrite>,
    createdBy: string,
    manager?: EntityManager,
  ): Promise<void>;
  findCustomValues(assetId: string): Promise<ReadonlyArray<CustomValueWithField>>;
  insertMovement(record: CreateMovementRecord): Promise<AssetMovement>;
  findRecentMovements(
    assetId: string,
    limit: number,
  ): Promise<ReadonlyArray<AssetMovement>>;
  insertPhoto(
    assetId: string,
    fileUrl: string,
    uploadedBy: string,
    manager?: EntityManager,
  ): Promise<void>;
  findAcquisitionTypeById(id: string): Promise<AcquisitionType | null>;
  listAcquisitionTypes(): Promise<ReadonlyArray<AcquisitionType>>;
  findNamedCategory(id: string): Promise<NamedRef | null>;
  findNamedCostCenter(id: string): Promise<NamedRef | null>;
  findNamedLocation(id: string): Promise<NamedRef | null>;
  findCategoryCode(code: string): Promise<NamedRef | null>;
  findCostCenterByExternalCode(code: string): Promise<NamedRef | null>;
  findLocationByCode(code: string): Promise<NamedRef | null>;
  findAcquisitionTypeByCode(code: string): Promise<AcquisitionType | null>;
  countActiveLoans(assetId: string): Promise<number>;
  findActiveLoans(
    assetId: string,
  ): Promise<ReadonlyArray<{ readonly id: string; readonly status: string }>>;
  countOpenInventories(assetId: string): Promise<number>;
  saveImportBatch(record: {
    readonly filename: string;
    readonly payload: unknown;
    readonly expiresAt: Date;
    readonly createdBy: string;
  }): Promise<AssetImportBatch>;
  findImportBatch(id: string): Promise<AssetImportBatch | null>;
  markImportCommitted(id: string): Promise<void>;
}
