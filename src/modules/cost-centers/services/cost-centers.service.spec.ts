import type { DataSource } from 'typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import { OrganizationalUnit } from '../../organizational-units/entities/organizational-unit.entity.js';
import { CostCenter } from '../entities/cost-center.entity.js';
import { CostCenterSyncSource } from '../enums/cost-center-sync-source.enum.js';
import type { CostCentersRepository } from '../repositories/cost-centers.repository.interface.js';
import type { CostCenterPlacementService } from './cost-center-placement.service.js';
import { CostCentersService } from './cost-centers.service.js';
import type { OrgStructureHistoryService } from './org-structure-history.service.js';
import type { StructureReconcilerService } from './structure-reconciler.service.js';
import type { StructureRemovalService } from './structure-removal.service.js';

const actor: AuthenticatedUser = {
  id: 'admin-1',
  personId: 'person-1',
  username: 'admin',
  roles: ['SUPER_ADMIN'],
  scopes: [{ type: 'GLOBAL', id: null }],
};

const center = (code: string, active = true): CostCenter => {
  const item = new CostCenter();
  item.id = `cc-${code}`;
  item.externalCode = code;
  item.name = `Centro ${code}`;
  item.organizationalUnitId = 'ou-1';
  item.parentId = null;
  item.acceptsAssets = true;
  item.isActive = active;
  item.syncSource = CostCenterSyncSource.Manual;
  item.lastSyncedAt = null;
  return item;
};

describe('CostCentersService', () => {
  let costCentersRepository: CostCentersRepository;
  let service: CostCentersService;
  let reconciler: { reconcileWithin: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    const org = new OrganizationalUnit();
    org.id = 'ou-1';
    org.code = 'DTH';
    costCentersRepository = {
      findAll: vi.fn().mockResolvedValue([]),
      findById: vi.fn(),
      findActiveById: vi.fn(),
      findOrgUnitById: vi.fn().mockResolvedValue(org),
      insert: vi.fn().mockImplementation(async (record) => {
        const created = center(record.externalCode);
        created.name = record.name;
        return created;
      }),
      update: vi.fn(),
      countActiveAssets: vi.fn().mockResolvedValue(0),
    };
    const auditLogsRepository: AuditLogsRepository = {
      record: vi.fn().mockResolvedValue(undefined),
      findLastLogins: vi.fn(),
    };
    reconciler = { reconcileWithin: vi.fn().mockResolvedValue({}) };
    service = new CostCentersService(
      costCentersRepository,
      auditLogsRepository,
      { transaction: vi.fn(async (work: (manager: unknown) => Promise<unknown>) => work({})) } as unknown as DataSource,
      {} as CostCenterPlacementService,
      {} as StructureRemovalService,
      {} as OrgStructureHistoryService,
      reconciler as unknown as StructureReconcilerService,
    );
  });

  it('no desactiva un centro con activos', async () => {
    vi.mocked(costCentersRepository.findById).mockResolvedValue(center('4330'));
    vi.mocked(costCentersRepository.countActiveAssets).mockResolvedValue(4);
    await expect(service.remove('cc-4330', actor)).rejects.toMatchObject({
      code: ErrorCode.CostCenterHasActiveAssets,
      details: [{ field: 'activeAssets', message: '4' }],
    });
  });
});
