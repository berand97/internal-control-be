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
  let removal: { inspectCostCenter: ReturnType<typeof vi.fn> };
  let org: OrganizationalUnit;

  beforeEach(() => {
    org = new OrganizationalUnit();
    org.id = 'ou-1';
    org.code = 'DTH';
    org.name = 'Talento Humano';
    org.isActive = true;
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
    };
    const auditLogsRepository: AuditLogsRepository = {
      record: vi.fn().mockResolvedValue(undefined),
      findLastLogins: vi.fn(),
    };
    reconciler = { reconcileWithin: vi.fn().mockResolvedValue({}) };
    removal = { inspectCostCenter: vi.fn().mockResolvedValue({ activeAssets: 0, activeChildren: 0, references: [] }) };
    service = new CostCentersService(
      costCentersRepository,
      auditLogsRepository,
      {
        transaction: vi.fn(async (work: (manager: unknown) => Promise<unknown>) => work({ query: vi.fn().mockResolvedValue([]) })),
      } as unknown as DataSource,
      {} as CostCenterPlacementService,
      removal as unknown as StructureRemovalService,
      {} as OrgStructureHistoryService,
      reconciler as unknown as StructureReconcilerService,
    );
  });

  it('no elimina un centro con activos', async () => {
    vi.mocked(costCentersRepository.findById).mockResolvedValue(center('4330'));
    removal.inspectCostCenter.mockResolvedValue({ activeAssets: 4, activeChildren: 0, references: [] });
    await expect(service.remove('cc-4330', actor)).rejects.toMatchObject({
      code: ErrorCode.CostCenterHasActiveAssets,
      details: [{ field: 'activeAssets', message: '4' }],
    });
  });

  it('desactivar por PATCH aplica la misma regla que eliminar: activos', async () => {
    vi.mocked(costCentersRepository.findById).mockResolvedValue(center('4330'));
    removal.inspectCostCenter.mockResolvedValue({ activeAssets: 2, activeChildren: 0, references: [] });
    await expect(service.update('cc-4330', { isActive: false }, actor)).rejects.toMatchObject({
      code: ErrorCode.CostCenterHasActiveAssets,
      details: [{ field: 'activeAssets', message: '2' }],
    });
    expect(costCentersRepository.update).not.toHaveBeenCalled();
  });

  it('desactivar por PATCH aplica la misma regla que eliminar: hijos activos', async () => {
    vi.mocked(costCentersRepository.findById).mockResolvedValue(center('4300'));
    removal.inspectCostCenter.mockResolvedValue({ activeAssets: 0, activeChildren: 3, references: [] });
    await expect(service.update('cc-4300', { isActive: false }, actor)).rejects.toMatchObject({
      code: ErrorCode.HasDependentEntities,
      message: 'Tiene 3 centros hijos activos',
    });
    expect(costCentersRepository.update).not.toHaveBeenCalled();
  });

  it('no reactiva un centro cuyo centro padre está archivado', async () => {
    const child = center('4310', false);
    child.parentId = 'cc-4300';
    const parent = center('4300', false);
    vi.mocked(costCentersRepository.findById).mockImplementation(async (id) => (id === 'cc-4300' ? parent : child));
    await expect(service.update('cc-4310', { isActive: true }, actor)).rejects.toMatchObject({
      code: ErrorCode.CostCenterParentInactive,
      message: 'No puede reactivarse: su centro padre 4300 · Centro 4300 está archivado. Reactive primero el centro padre.',
    });
    expect(costCentersRepository.update).not.toHaveBeenCalled();
  });

  it('no reactiva un centro cuya dependencia está inactiva', async () => {
    vi.mocked(costCentersRepository.findById).mockResolvedValue(center('4310', false));
    org.isActive = false;
    await expect(service.update('cc-4310', { isActive: true }, actor)).rejects.toMatchObject({
      code: ErrorCode.CostCenterOrgUnitInactive,
      details: [{ field: 'organizationalUnitId' }],
    });
    expect(costCentersRepository.update).not.toHaveBeenCalled();
  });
});
