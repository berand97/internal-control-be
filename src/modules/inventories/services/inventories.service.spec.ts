import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { InventoryScopeType } from '../enums/inventory-scope.js';
import { InventoryStatus } from '../enums/inventory-status.js';
import { VerificationResult } from '../enums/verification-result.js';
import { InventoriesService } from './inventories.service.js';

const actor: AuthenticatedUser = {
  id: 'admin-1',
  personId: 'person-1',
  username: 'admin',
  roles: ['INTERNAL_CONTROL_DIRECTOR'],
  scopes: [{ type: 'GLOBAL', id: null }],
};

const inventory = {
  id: 'inv-1',
  code: 'TF-2026-001',
  name: 'Toma TH',
  plannedStartDate: '2026-01-01',
  plannedEndDate: '2026-01-31',
  actualStartDate: null,
  actualEndDate: null,
  status: InventoryStatus.Planned,
  responsibleUserId: 'user-resp',
  scopeType: InventoryScopeType.CostCenter,
  scopeId: 'cc-1',
  scopeNotes: null,
  closedAt: null,
  closedBy: null,
  reconcileRequestedAt: null,
  reconcileRequestedBy: null,
  reconcileApprovedAt: null,
  reconcileApprovedBy: null,
  discrepancyReport: null,
  createdAt: new Date(),
  createdBy: 'admin-1',
};

describe('InventoriesService', () => {
  let inventories: {
    find: ReturnType<typeof vi.fn>;
    findOne: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    createQueryBuilder: ReturnType<typeof vi.fn>;
  };
  let items: {
    find: ReturnType<typeof vi.fn>;
    findOne: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  let scopes: { save: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  let assets: {
    findOne: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  let users: { findOne: ReturnType<typeof vi.fn> };
  let costCenters: { findOne: ReturnType<typeof vi.fn> };
  let locations: { findOne: ReturnType<typeof vi.fn> };
  let orgUnits: { findOne: ReturnType<typeof vi.fn> };
  let dataSource: { query: ReturnType<typeof vi.fn> };
  let movementsService: { record: ReturnType<typeof vi.fn> };
  let permissionsService: { userHasPermission: ReturnType<typeof vi.fn> };
  let auditLogsRepository: { record: ReturnType<typeof vi.fn> };
  let service: InventoriesService;

  beforeEach(() => {
    inventories = {
      find: vi.fn().mockResolvedValue([]),
      findOne: vi.fn(),
      save: vi.fn(async (row: typeof inventory) => row),
      create: vi.fn((row: typeof inventory) => row),
      createQueryBuilder: vi.fn(),
    };
    items = {
      find: vi.fn().mockResolvedValue([]),
      findOne: vi.fn(),
      save: vi.fn(async (row: unknown) => row),
      create: vi.fn((row: unknown) => row),
    };
    scopes = {
      save: vi.fn(),
      create: vi.fn((row: unknown) => row),
    };
    assets = {
      findOne: vi.fn(),
      update: vi.fn(),
    };
    users = {
      findOne: vi.fn().mockResolvedValue({ id: 'user-resp' }),
    };
    costCenters = {
      findOne: vi.fn().mockResolvedValue({ id: 'cc-1' }),
    };
    locations = { findOne: vi.fn() };
    orgUnits = { findOne: vi.fn() };
    dataSource = {
      query: vi.fn().mockResolvedValue([{ current_value: 1, padding_length: 3, prefix: 'TF-' }]),
    };
    movementsService = { record: vi.fn() };
    permissionsService = { userHasPermission: vi.fn() };
    auditLogsRepository = { record: vi.fn() };
    service = new InventoriesService(
      inventories as never,
      items as never,
      scopes as never,
      assets as never,
      users as never,
      costCenters as never,
      locations as never,
      orgUnits as never,
      dataSource as never,
      movementsService as never,
      permissionsService as never,
      auditLogsRepository as never,
    );
  });

  it('crea una toma PLANNED y rechaza solape GLOBAL', async () => {
    inventories.find.mockResolvedValueOnce([
      { ...inventory, scopeType: InventoryScopeType.Global, scopeId: null },
    ]);
    await expect(
      service.create(
        {
          name: 'Toma TH',
          scope: InventoryScopeType.CostCenter,
          scopeId: 'cc-1',
          plannedStartDate: '2026-01-01',
          plannedEndDate: '2026-01-31',
          responsibleUserId: 'user-resp',
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.InventoryScopeOverlap });
  });

  it('congela snapshot al iniciar', async () => {
    inventories.findOne.mockResolvedValue({ ...inventory });
    dataSource.query.mockResolvedValueOnce([
      {
        id: 'asset-1',
        current_location_id: 'loc-1',
        physical_condition: 'GOOD',
        current_cost_center_id: 'cc-1',
        operational_status: 'IN_USE',
      },
    ]);
    await service.start('inv-1', actor);
    expect(items.save).toHaveBeenCalled();
    expect(inventories.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: InventoryStatus.InProgress }),
    );
  });

  it('no cierra si más del 5% sigue pendiente', async () => {
    inventories.findOne.mockResolvedValue({
      ...inventory,
      status: InventoryStatus.InProgress,
    });
    items.find.mockResolvedValue(
      Array.from({ length: 10 }, (_, index) => ({
        id: `i-${index}`,
        inventoryId: 'inv-1',
        assetId: `a-${index}`,
        verificationResult:
          index === 0 ? VerificationResult.Found : VerificationResult.Pending,
        isOnLoan: false,
      })),
    );
    await expect(
      service.close('inv-1', {}, actor),
    ).rejects.toMatchObject({
      code: ErrorCode.InventoryUnverifiedExceedsThreshold,
    });
  });

  it('impide que el responsable apruebe su propia reconciliación', async () => {
    inventories.findOne.mockResolvedValue({
      ...inventory,
      status: InventoryStatus.Closed,
      reconcileRequestedBy: actor.id,
      responsibleUserId: actor.id,
    });
    await expect(service.approveReconcile('inv-1', actor)).rejects.toMatchObject({
      code: ErrorCode.InventoryReconcileSod,
    });
  });
});
