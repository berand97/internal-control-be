import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, type EntityManager, Repository } from 'typeorm';
import { AssetCategory } from '../../categories/entities/asset-category.entity.js';
import { CostCenter } from '../../cost-centers/entities/cost-center.entity.js';
import { AssetCategoryField } from '../../dynamic-fields/entities/asset-category-field.entity.js';
import { Location } from '../../locations/entities/location.entity.js';
import { AcquisitionType } from '../entities/acquisition-type.entity.js';
import { AssetCustomValue } from '../entities/asset-custom-value.entity.js';
import { AssetIdentifier } from '../entities/asset-identifier.entity.js';
import { AssetImportBatch } from '../entities/asset-import-batch.entity.js';
import { AssetMovement } from '../entities/asset-movement.entity.js';
import { AssetPhoto } from '../entities/asset-photo.entity.js';
import { Asset } from '../entities/asset.entity.js';
import type {
  AssetIdentifierWrite,
  AssetSearchFilters,
  AssetsRepository,
  CreateAssetRecord,
  CreateMovementRecord,
  CustomValueWithField,
  CustomValueWrite,
  NamedRef,
  UpdateAssetRecord,
} from './assets.repository.interface.js';

const SORT_COLUMNS: Record<string, string> = {
  internalCode: 'asset.internal_code',
  description: 'asset.description',
  acquisitionDate: 'asset.acquisition_date',
  operationalStatus: 'asset.operational_status',
  createdAt: 'asset.created_at',
};

@Injectable()
export class TypeOrmAssetsRepository implements AssetsRepository {
  constructor(
    @InjectRepository(Asset)
    private readonly assets: Repository<Asset>,
    @InjectRepository(AssetCustomValue)
    private readonly customValues: Repository<AssetCustomValue>,
    @InjectRepository(AssetMovement)
    private readonly movements: Repository<AssetMovement>,
    @InjectRepository(AssetPhoto)
    private readonly photos: Repository<AssetPhoto>,
    @InjectRepository(AcquisitionType)
    private readonly acquisitionTypes: Repository<AcquisitionType>,
    @InjectRepository(AssetImportBatch)
    private readonly importBatches: Repository<AssetImportBatch>,
    private readonly dataSource: DataSource,
  ) {}

  async findPage(
    filters: AssetSearchFilters,
  ): Promise<{ items: ReadonlyArray<Asset>; total: number }> {
    const qb = this.assets.createQueryBuilder('asset');
    if (filters.q) {
      qb.andWhere(
        '(asset.description ILIKE :q OR asset.internal_code ILIKE :q OR asset.serial_number ILIKE :q)',
        { q: `%${filters.q}%` },
      );
    }
    if (filters.categoryId) {
      qb.andWhere('asset.category_id = :categoryId', {
        categoryId: filters.categoryId,
      });
    }
    if (filters.costCenterId) {
      qb.andWhere('asset.current_cost_center_id = :costCenterId', {
        costCenterId: filters.costCenterId,
      });
    }
    if (filters.locationId) {
      qb.andWhere('asset.current_location_id = :locationId', {
        locationId: filters.locationId,
      });
    }
    if (filters.operationalStatus) {
      qb.andWhere('asset.operational_status = :operationalStatus', {
        operationalStatus: filters.operationalStatus,
      });
    }
    if (filters.acquiredFrom) {
      qb.andWhere('asset.acquisition_date >= :acquiredFrom', {
        acquiredFrom: filters.acquiredFrom,
      });
    }
    if (filters.acquiredTo) {
      qb.andWhere('asset.acquisition_date <= :acquiredTo', {
        acquiredTo: filters.acquiredTo,
      });
    }
    if (filters.hasBarcode === true) {
      qb.andWhere('asset.barcode IS NOT NULL');
    }
    if (filters.hasBarcode === false) {
      qb.andWhere('asset.barcode IS NULL');
    }
    const sortColumn = SORT_COLUMNS[filters.sortBy] ?? 'asset.created_at';
    qb.orderBy(sortColumn, filters.sortOrder);
    const total = await qb.getCount();
    const items = await qb
      .skip((filters.page - 1) * filters.pageSize)
      .take(filters.pageSize)
      .getMany();
    return { items, total };
  }

  findById(id: string): Promise<Asset | null> {
    return this.assets.findOne({ where: { id } });
  }

  findByInternalCode(code: string): Promise<Asset | null> {
    return this.assets.findOne({ where: { internalCode: code } });
  }

  insert(record: CreateAssetRecord, manager?: EntityManager): Promise<Asset> {
    const assets = manager?.getRepository(Asset) ?? this.assets;
    const now = new Date();
    const entity = assets.create({
      ...record,
      qrToken: null,
      qrTokenVersion: 1,
      qrSignedAt: null,
      qrSignedBy: null,
      writtenOffAt: null,
      writeOffReason: null,
      writeOffDocument: null,
      writeOffApprovedBy: null,
      manufacturerId: null,
      supplierId: null,
      insurancePolicyNumber: null,
      warrantyExpiresAt: null,
      lastVerifiedAt: null,
      createdAt: now,
      updatedAt: now,
      updatedBy: record.createdBy,
    });
    return assets.save(entity);
  }

  async update(
    id: string,
    record: UpdateAssetRecord,
    manager?: EntityManager,
  ): Promise<void> {
    const assets = manager?.getRepository(Asset) ?? this.assets;
    await assets.update({ id }, { ...record, updatedAt: new Date() });
  }


  async nextInternalCode(year: number, manager?: EntityManager): Promise<string> {
   const rows = (await (manager ?? this.dataSource.manager).query(
      `
      WITH reserved AS (
        UPDATE code_sequence
        SET current_value = current_value + 1, updated_at = NOW()
        WHERE sequence_name = 'asset_internal_code'
        RETURNING current_value, padding_length
      )
      SELECT current_value, padding_length FROM reserved
      `,
    )) as Array<{ current_value: string; padding_length: number }>;
    const row = rows[0];
    if (!row) {
      throw new Error("Falta la secuencia 'asset_internal_code' en code_sequence");
    }
    const value = Number(row.current_value);
    return `A${year}-${String(value).padStart(row.padding_length, '0')}`;
  }

  async replaceCustomValues(
    assetId: string,
    values: ReadonlyArray<CustomValueWrite>,
    manager?: EntityManager,
  ): Promise<void> {
    const customValues =
      manager?.getRepository(AssetCustomValue) ?? this.customValues;
    await customValues.delete({ assetId });
    if (values.length === 0) {
      return;
    }
    const now = new Date();
    await customValues.save(
      values.map((value) =>
        customValues.create({
          assetId,
          fieldId: value.fieldId,
          ...value.columns,
          updatedAt: now,
        }),
      ),
    );
  }

  async insertIdentifiers(
    assetId: string,
    identifiers: ReadonlyArray<AssetIdentifierWrite>,
    createdBy: string,
    manager?: EntityManager,
  ): Promise<void> {
    const repository = (manager ?? this.dataSource.manager).getRepository(
      AssetIdentifier,
    );
    const now = new Date();
    await repository.save(
      identifiers.map((identifier) =>
        repository.create({
          assetId,
          identifierType: identifier.type,
          value: identifier.value,
          origin: identifier.origin,
          validFrom: now,
          validTo: null,
          createdAt: now,
          createdBy,
        }),
      ),
    );
  }

  async findCustomValues(
    assetId: string,
  ): Promise<ReadonlyArray<CustomValueWithField>> {
    const rows = await this.customValues
      .createQueryBuilder('value')
      .innerJoin(AssetCategoryField, 'field', 'field.id = value.field_id')
      .where('value.asset_id = :assetId', { assetId })
      .select([
        'value.asset_id AS "assetId"',
        'value.field_id AS "fieldId"',
        'value.value_text AS "valueText"',
        'value.value_number AS "valueNumber"',
        'value.value_date AS "valueDate"',
        'value.value_boolean AS "valueBoolean"',
        'value.value_json AS "valueJson"',
        'value.updated_at AS "updatedAt"',
        'field.field_code AS code',
        'field.field_label AS label',
        'field.field_type AS type',
      ])
      .getRawMany<{
        assetId: string;
        fieldId: string;
        valueText: string | null;
        valueNumber: string | null;
        valueDate: string | null;
        valueBoolean: boolean | null;
        valueJson: unknown;
        updatedAt: Date;
        code: string;
        label: string;
        type: CustomValueWithField['type'];
      }>();
    return rows.map((raw) => {
      const row = new AssetCustomValue();
      row.assetId = raw.assetId;
      row.fieldId = raw.fieldId;
      row.valueText = raw.valueText;
      row.valueNumber = raw.valueNumber;
      row.valueDate = raw.valueDate;
      row.valueBoolean = raw.valueBoolean;
      row.valueJson = raw.valueJson;
      row.updatedAt = raw.updatedAt;
      return { row, code: raw.code, label: raw.label, type: raw.type };
    });
  }

  insertMovement(record: CreateMovementRecord): Promise<AssetMovement> {
    const now = new Date();
    const entity = this.movements.create({
      ...record,
      executedAt: now,
      createdAt: now,
    });
    return this.movements.save(entity);
  }

  findRecentMovements(
    assetId: string,
    limit: number,
  ): Promise<ReadonlyArray<AssetMovement>> {
    return this.movements.find({
      where: { assetId },
      order: { executedAt: 'DESC' },
      take: limit,
    });
  }

  async insertPhoto(
    assetId: string,
    fileUrl: string,
    uploadedBy: string,
    manager?: EntityManager,
  ): Promise<void> {
    const photos = manager?.getRepository(AssetPhoto) ?? this.photos;
    const entity = photos.create({
      assetId,
      fileUrl,
      isPrimary: true,
      uploadedAt: new Date(),
      uploadedBy,
    });
    await photos.save(entity);
  }

  findAcquisitionTypeById(id: string): Promise<AcquisitionType | null> {
    return this.acquisitionTypes.findOne({ where: { id } });
  }

  listAcquisitionTypes(): Promise<ReadonlyArray<AcquisitionType>> {
    return this.acquisitionTypes.find({
      where: { isActive: true },
      order: { name: 'ASC' },
    });
  }

  async findNamedCategory(id: string): Promise<NamedRef | null> {
    const row = await this.dataSource.getRepository(AssetCategory).findOne({
      where: { id },
    });
    return row ? { id: row.id, code: row.code, name: row.name } : null;
  }

  async findNamedCostCenter(id: string): Promise<NamedRef | null> {
    const row = await this.dataSource.getRepository(CostCenter).findOne({
      where: { id },
    });
    return row
      ? { id: row.id, code: row.externalCode, name: row.name }
      : null;
  }

  async findNamedLocation(id: string): Promise<NamedRef | null> {
    const row = await this.dataSource.getRepository(Location).findOne({
      where: { id },
    });
    return row ? { id: row.id, code: row.code, name: row.name } : null;
  }

  async findCategoryCode(code: string): Promise<NamedRef | null> {
    const row = await this.dataSource.getRepository(AssetCategory).findOne({
      where: { code },
    });
    return row ? { id: row.id, code: row.code, name: row.name } : null;
  }

  async findCostCenterByExternalCode(code: string): Promise<NamedRef | null> {
    const row = await this.dataSource.getRepository(CostCenter).findOne({
      where: { externalCode: code },
    });
    return row
      ? { id: row.id, code: row.externalCode, name: row.name }
      : null;
  }

  async findLocationByCode(code: string): Promise<NamedRef | null> {
    const row = await this.dataSource.getRepository(Location).findOne({
      where: { code },
    });
    return row ? { id: row.id, code: row.code, name: row.name } : null;
  }

  findAcquisitionTypeByCode(code: string): Promise<AcquisitionType | null> {
    return this.acquisitionTypes.findOne({ where: { code } });
  }

  async countActiveLoans(assetId: string): Promise<number> {
    const rows: unknown = await this.dataSource.query(
      `
      SELECT COUNT(*)::int AS count
      FROM asset_loan_item i
      JOIN asset_loan l ON l.id = i.loan_id
      WHERE i.asset_id = $1
        AND l.status IN ('APPROVED','IN_TRANSIT','ACTIVE','OVERDUE','PENDING_RECEPTION')
      `,
      [assetId],
    );
    return countFrom(rows);
  }

  async findActiveLoans(
    assetId: string,
  ): Promise<ReadonlyArray<{ readonly id: string; readonly status: string }>> {
    const rows: unknown = await this.dataSource.query(
      `
      SELECT DISTINCT l.id, l.status
      FROM asset_loan l
      JOIN asset_loan_item i ON i.loan_id = l.id
      WHERE i.asset_id = $1
        AND l.status IN ('APPROVED','IN_TRANSIT','ACTIVE','OVERDUE','PENDING_RECEPTION')
      `,
      [assetId],
    );
    if (!Array.isArray(rows)) {
      return [];
    }
    return rows
      .filter((row): row is { id: string; status: string } => {
        return (
          typeof row === 'object' &&
          row !== null &&
          typeof (row as { id?: unknown }).id === 'string' &&
          typeof (row as { status?: unknown }).status === 'string'
        );
      })
      .map((row) => ({ id: row.id, status: row.status }));
  }

  async countOpenInventories(assetId: string): Promise<number> {
    const rows: unknown = await this.dataSource.query(
      `
      SELECT COUNT(*)::int AS count
      FROM physical_inventory_item i
      JOIN physical_inventory p ON p.id = i.inventory_id
      WHERE i.asset_id = $1 AND p.status IN ('PLANNED', 'IN_PROGRESS')
      `,
      [assetId],
    );
    return countFrom(rows);
  }

  saveImportBatch(record: {
    readonly filename: string;
    readonly payload: unknown;
    readonly expiresAt: Date;
    readonly createdBy: string;
  }): Promise<AssetImportBatch> {
    const entity = this.importBatches.create({
      ...record,
      createdAt: new Date(),
      committedAt: null,
    });
    return this.importBatches.save(entity);
  }

  findImportBatch(id: string): Promise<AssetImportBatch | null> {
    return this.importBatches.findOne({ where: { id } });
  }

  async markImportCommitted(id: string): Promise<void> {
    await this.importBatches.update({ id }, { committedAt: new Date() });
  }
}

const countFrom = (rows: unknown): number => {
  if (Array.isArray(rows) && rows[0] && typeof rows[0] === 'object') {
    const row = rows[0] as { count?: number };
    return typeof row.count === 'number' ? row.count : 0;
  }
  return 0;
};
