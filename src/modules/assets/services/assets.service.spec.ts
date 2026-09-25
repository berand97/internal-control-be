import type { DataSource } from 'typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import type { CategoriesRepository } from '../../categories/repositories/categories.repository.interface.js';
import { AssetCategory } from '../../categories/entities/asset-category.entity.js';
import { DepreciationMethod } from '../../categories/enums/depreciation-method.enum.js';
import type { CostCentersRepository } from '../../cost-centers/repositories/cost-centers.repository.interface.js';
import { CostCenter } from '../../cost-centers/entities/cost-center.entity.js';
import { CostCenterSyncSource } from '../../cost-centers/enums/cost-center-sync-source.enum.js';
import { DynamicFieldType } from '../../dynamic-fields/enums/dynamic-field-type.enum.js';
import { DynamicFieldsService } from '../../dynamic-fields/services/dynamic-fields.service.js';
import type { LocationsRepository } from '../../locations/repositories/locations.repository.interface.js';
import { AcquisitionType } from '../entities/acquisition-type.entity.js';
import { Asset } from '../entities/asset.entity.js';
import { OperationalStatus } from '../enums/operational-status.enum.js';
import { PhysicalCondition } from '../enums/physical-condition.enum.js';
import type { AssetsRepository } from '../repositories/assets.repository.interface.js';
import type { MovementsService } from '../../movements/services/movements.service.js';
import { AssetsService } from './assets.service.js';

const actor: AuthenticatedUser = {
  id: 'admin-1',
  personId: 'person-1',
  username: 'admin',
  roles: ['SUPER_ADMIN'],
  scopes: [{ type: 'GLOBAL', id: null }],
};

const category = (): AssetCategory => {
  const item = new AssetCategory();
  item.id = 'cat-1';
  item.parentId = null;
  item.code = 'PORTATILES';
  item.name = 'Portátiles';
  item.description = null;
  item.depreciationYears = 4;
  item.depreciationMethod = DepreciationMethod.StraightLine;
  item.requiresSerialNumber = true;
  item.requiresPhoto = false;
  item.hierarchyPath = '/computadores/portatiles';
  item.isActive = true;
  item.createdAt = new Date();
  return item;
};

const center = (): CostCenter => {
  const item = new CostCenter();
  item.id = 'cc-1';
  item.externalCode = '4100';
  item.name = 'Control Interno';
  item.organizationalUnitId = null;
  item.parentId = null;
  item.acceptsAssets = true;
  item.isActive = true;
  item.syncSource = CostCenterSyncSource.Manual;
  item.lastSyncedAt = null;
  item.externalMetadata = null;
  item.createdAt = new Date();
  item.updatedAt = new Date();
  return item;
};

const acquisition = (): AcquisitionType => {
  const item = new AcquisitionType();
  item.id = 'acq-1';
  item.code = 'PURCHASE';
  item.name = 'Compra';
  item.isActive = true;
  return item;
};

const asset = (): Asset => {
  const item = new Asset();
  item.id = 'asset-1';
  item.internalCode = 'A2026-0001';
  item.barcode = null;
  item.serialNumber = 'SN-1';
  item.description = 'Portátil Dell';
  item.model = 'Latitude';
  item.categoryId = 'cat-1';
  item.manufacturerId = null;
  item.acquisitionTypeId = 'acq-1';
  item.acquisitionDate = '2026-03-15';
  item.acquisitionDocument = null;
  item.supplierId = null;
  item.acquisitionPrice = '2500000';
  item.currency = 'COP';
  item.operationalStatus = OperationalStatus.InUse;
  item.physicalCondition = PhysicalCondition.New;
  item.costCenterId = 'cc-1';
  item.locationId = null;
  item.responsibleId = null;
  item.writtenOffAt = null;
  item.writeOffReason = null;
  item.writeOffDocument = null;
  item.writeOffApprovedBy = null;
  item.qrToken = null;
  item.qrTokenVersion = 1;
  item.qrSignedAt = null;
  item.qrSignedBy = null;
  item.depreciationMethod = DepreciationMethod.StraightLine;
  item.usefulLifeYears = 4;
  item.salvageValue = '0';
  item.notes = null;
  item.warrantyExpiresAt = null;
  item.insurancePolicyNumber = null;
  item.createdAt = new Date();
  item.createdBy = actor.id;
  item.updatedAt = new Date();
  item.updatedBy = actor.id;
  return item;
};

describe('AssetsService', () => {
  let assetsRepository: AssetsRepository;
  let categoriesRepository: CategoriesRepository;
  let costCentersRepository: CostCentersRepository;
  let locationsRepository: LocationsRepository;
  let dynamicFieldsService: DynamicFieldsService;
  let movementsService: Pick<MovementsService, 'record'>;
  let service: AssetsService;

  beforeEach(() => {
    assetsRepository = {
      findPage: vi.fn(),
      findById: vi.fn(),
      findByInternalCode: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      nextInternalCode: vi.fn().mockResolvedValue('A2026-0001'),
      replaceCustomValues: vi.fn(),
      insertIdentifiers: vi.fn(),
      findCustomValues: vi.fn().mockResolvedValue([]),
      insertMovement: vi.fn(),
      findRecentMovements: vi.fn().mockResolvedValue([]),
      insertPhoto: vi.fn(),
      findAcquisitionTypeById: vi.fn().mockResolvedValue(acquisition()),
      listAcquisitionTypes: vi.fn().mockResolvedValue([acquisition()]),
      findNamedCategory: vi.fn().mockResolvedValue({
        id: 'cat-1',
        code: 'PORTATILES',
        name: 'Portátiles',
      }),
      findNamedCostCenter: vi.fn().mockResolvedValue({
        id: 'cc-1',
        code: '4100',
        name: 'Control Interno',
      }),
      findNamedLocation: vi.fn(),
      findCategoryCode: vi.fn(),
      findCostCenterByExternalCode: vi.fn(),
      findLocationByCode: vi.fn(),
      findAcquisitionTypeByCode: vi.fn(),
      countActiveLoans: vi.fn().mockResolvedValue(0),
      findActiveLoans: vi.fn().mockResolvedValue([]),
      countOpenInventories: vi.fn().mockResolvedValue(0),
      saveImportBatch: vi.fn(),
      findImportBatch: vi.fn(),
      markImportCommitted: vi.fn(),
    };
    categoriesRepository = {
      findAll: vi.fn(),
      findById: vi.fn().mockResolvedValue(category()),
      insert: vi.fn(),
      update: vi.fn(),
      deactivate: vi.fn(),
      countActiveChildren: vi.fn(),
      countAssets: vi.fn(),
      rewriteDescendantPaths: vi.fn(),
    };
    costCentersRepository = {
      findAll: vi.fn(),
      findById: vi.fn(),
      findActiveById: vi.fn().mockResolvedValue(center()),
      findByExternalCode: vi.fn(),
      findOrgUnitById: vi.fn(),
      findOrgUnitByCode: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      deactivate: vi.fn(),
      countActiveAssets: vi.fn(),
      insertSyncLog: vi.fn(),
    };
    locationsRepository = {
      findByBuilding: vi.fn(),
      findById: vi.fn(),
      findByIdWithPath: vi.fn(),
      findBuildingById: vi.fn(),
      search: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      deactivate: vi.fn(),
    };
    dynamicFieldsService = {
      effectiveFields: vi.fn().mockResolvedValue([
        {
          id: 'f-ram',
          categoryId: 'cat-1',
          code: 'ramGB',
          label: 'RAM',
          type: DynamicFieldType.Number,
          isRequired: true,
          defaultValue: null,
          selectOptions: null,
          validationRules: { min: 4, max: 128 },
          orderIndex: 1,
          isActive: true,
          inherited: false,
          inheritedFromCategoryId: null,
        },
      ]),
    } as unknown as DynamicFieldsService;
    const auditLogsRepository: AuditLogsRepository = {
      record: vi.fn().mockResolvedValue(undefined),
      findLastLogins: vi.fn(),
    };
    movementsService = { record: vi.fn().mockResolvedValue({}) };
    service = new AssetsService(
      assetsRepository,
      categoriesRepository,
      costCentersRepository,
      locationsRepository,
      dynamicFieldsService,
      auditLogsRepository,
      movementsService as MovementsService,
      {
        transaction: (work: (manager: unknown) => Promise<unknown>) =>
          work({}),
      } as unknown as DataSource,
    );
  });

  it('crea un activo con campos dinámicos requeridos', async () => {
    vi.mocked(assetsRepository.insert).mockResolvedValue(asset());
    const result = await service.create(
      {
        description: 'Portátil Dell',
        categoryId: 'cat-1',
        costCenterId: 'cc-1',
        acquisitionTypeId: 'acq-1',
        acquisitionDate: '2026-03-15',
        serialNumber: 'SN-1',
        customValues: { ramGB: 16 },
      },
      actor,
    );
    expect(result.internalCode).toBe('A2026-0001');
    expect(assetsRepository.replaceCustomValues).toHaveBeenCalled();
  });

  it('rechaza el alta si falta un campo dinámico requerido', async () => {
    await expect(
      service.create(
        {
          description: 'Portátil Dell',
          categoryId: 'cat-1',
          costCenterId: 'cc-1',
          acquisitionTypeId: 'acq-1',
          acquisitionDate: '2026-03-15',
          serialNumber: 'SN-1',
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.AssetMissingCustomField });
  });

  it('exige serie cuando la categoría lo requiere', async () => {
    await expect(
      service.create(
        {
          description: 'Portátil Dell',
          categoryId: 'cat-1',
          costCenterId: 'cc-1',
          acquisitionTypeId: 'acq-1',
          acquisitionDate: '2026-03-15',
          customValues: { ramGB: 16 },
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.AssetSerialRequired });
  });

  it('no permite editar un activo dado de baja', async () => {
    const written = asset();
    written.operationalStatus = OperationalStatus.WrittenOff;
    written.writtenOffAt = '2026-11-01';
    vi.mocked(assetsRepository.findById).mockResolvedValue(written);
    await expect(
      service.update('asset-1', { description: 'x' }, actor),
    ).rejects.toMatchObject({ code: ErrorCode.AssetAlreadyWrittenOff });
  });

  it('no cambia a WRITTEN_OFF por change-status', async () => {
    vi.mocked(assetsRepository.findById).mockResolvedValue(asset());
    await expect(
      service.changeStatus(
        'asset-1',
        OperationalStatus.WrittenOff,
        'baja',
        actor,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.AssetInvalidStatusTransition });
  });

  it('da de baja y registra movimiento', async () => {
    vi.mocked(assetsRepository.findById).mockResolvedValue(asset());
    const result = await service.writeOff(
      'asset-1',
      { reason: 'Obsoleto', documentReference: 'ACTA-1' },
      actor,
    );
    expect(assetsRepository.update).toHaveBeenCalledWith(
      'asset-1',
      expect.objectContaining({
        operationalStatus: OperationalStatus.WrittenOff,
      }),
    );
    expect(movementsService.record).toHaveBeenCalled();
    expect(result.id).toBe('asset-1');
  });

  it('bloquea baja si hay préstamo activo', async () => {
    vi.mocked(assetsRepository.findById).mockResolvedValue(asset());
    vi.mocked(assetsRepository.countActiveLoans).mockResolvedValue(1);
    await expect(
      service.writeOff(
        'asset-1',
        { reason: 'x', documentReference: 'ACTA-1' },
        actor,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.AssetHasActiveLoan });
  });
});
