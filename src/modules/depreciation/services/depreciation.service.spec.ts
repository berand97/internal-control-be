import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { DepreciationMethod } from '../../categories/enums/depreciation-method.enum.js';
import { OperationalStatus } from '../../assets/enums/operational-status.enum.js';
import { DepreciationService } from './depreciation.service.js';

const actor: AuthenticatedUser = {
  id: 'admin-1',
  personId: 'person-1',
  username: 'admin',
  roles: ['INTERNAL_CONTROL_DIRECTOR'],
  scopes: [{ type: 'GLOBAL', id: null }],
};

describe('DepreciationService', () => {
  let snapshots: {
    manager: {
      transaction: ReturnType<typeof vi.fn>;
      query: ReturnType<typeof vi.fn>;
    };
    find: ReturnType<typeof vi.fn>;
    createQueryBuilder: ReturnType<typeof vi.fn>;
  };
  let assets: { find: ReturnType<typeof vi.fn>; findOne: ReturnType<typeof vi.fn> };
  let auditLogsRepository: { record: ReturnType<typeof vi.fn> };
  let service: DepreciationService;

  beforeEach(() => {
    snapshots = {
      manager: {
        transaction: vi.fn(async (fn: (manager: unknown) => Promise<void>) => {
          const repo = {
            delete: vi.fn(),
            create: vi.fn((row: unknown) => row),
            save: vi.fn(),
          };
          await fn({ getRepository: () => repo });
        }),
        query: vi.fn().mockResolvedValue([]),
      },
      find: vi.fn().mockResolvedValue([]),
      createQueryBuilder: vi.fn(),
    };
    assets = {
      find: vi.fn().mockResolvedValue([
        {
          id: 'asset-1',
          acquisitionDate: '2024-01-15',
          acquisitionPrice: '12000',
          salvageValue: '0',
          usefulLifeYears: 4,
          depreciationMethod: DepreciationMethod.StraightLine,
          operationalStatus: OperationalStatus.InUse,
          writtenOffAt: null,
          costCenterId: 'cc-1',
          categoryId: 'cat-1',
        },
      ]),
      findOne: vi.fn(),
    };
    auditLogsRepository = { record: vi.fn() };
    service = new DepreciationService(
      snapshots as never,
      assets as never,
      auditLogsRepository as never,
    );
  });

  it('regenera el período de forma idempotente', async () => {
    const first = await service.calculate({ year: 2024, month: 2 }, actor);
    const second = await service.calculate({ year: 2024, month: 2 }, actor);
    expect(first.calculated).toBe(1);
    expect(second.calculated).toBe(1);
    expect(snapshots.manager.transaction).toHaveBeenCalledTimes(2);
  });

  it('lista el histórico de un activo', async () => {
    assets.findOne.mockResolvedValue({
      id: 'asset-1',
      depreciationMethod: DepreciationMethod.StraightLine,
    });
    snapshots.find.mockResolvedValue([
      {
        id: 's-1',
        assetId: 'asset-1',
        periodYear: 2024,
        periodMonth: 2,
        method: DepreciationMethod.StraightLine,
        monthlyDepreciation: '250.00',
        accumulatedDepreciation: '250.00',
        bookValue: '11750.00',
        isClosed: false,
        calculatedAt: new Date(),
        calculatedBy: 'admin-1',
      },
    ]);
    const result = await service.history('asset-1');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.monthlyDepreciation).toBe('250.00');
  });
});
