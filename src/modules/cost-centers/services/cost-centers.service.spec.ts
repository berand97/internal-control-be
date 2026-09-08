import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import { OrganizationalUnit } from '../../organizational-units/entities/organizational-unit.entity.js';
import { CostCenter } from '../entities/cost-center.entity.js';
import { CostCenterSyncLog } from '../entities/cost-center-sync-log.entity.js';
import { CostCenterSyncSource } from '../enums/cost-center-sync-source.enum.js';
import type { CostCentersRepository } from '../repositories/cost-centers.repository.interface.js';
import { CostCentersService } from './cost-centers.service.js';

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

  beforeEach(() => {
    const org = new OrganizationalUnit();
    org.id = 'ou-1';
    org.code = 'DTH';
    costCentersRepository = {
      findAll: vi.fn().mockResolvedValue([]),
      findById: vi.fn(),
      findActiveById: vi.fn(),
      findByExternalCode: vi.fn().mockResolvedValue(null),
      findOrgUnitById: vi.fn().mockResolvedValue(org),
      findOrgUnitByCode: vi.fn().mockResolvedValue(org),
      insert: vi.fn().mockImplementation(async (record) => {
        const created = center(record.externalCode);
        created.name = record.name;
        return created;
      }),
      update: vi.fn(),
      deactivate: vi.fn(),
      countActiveAssets: vi.fn().mockResolvedValue(0),
      insertSyncLog: vi.fn().mockImplementation(async (record) => {
        const log = new CostCenterSyncLog();
        log.id = 'sync-1';
        log.filename = record.filename;
        log.createdCount = record.createdCount;
        log.updatedCount = record.updatedCount;
        log.deactivatedCount = record.deactivatedCount;
        log.reactivatedCount = record.reactivatedCount;
        return log;
      }),
    };
    const auditLogsRepository: AuditLogsRepository = {
      record: vi.fn().mockResolvedValue(undefined),
      findLastLogins: vi.fn(),
    };
    service = new CostCentersService(costCentersRepository, auditLogsRepository);
  });

  it('sincroniza creación, actualización, desactivación y reactivación', async () => {
    const existing = center('4330');
    const inactive = center('4100', false);
    const stale = center('9999');
    vi.mocked(costCentersRepository.findByExternalCode).mockImplementation(
      async (code) => {
        if (code === '4330') {
          return existing;
        }
        if (code === '4100') {
          return inactive;
        }
        return null;
      },
    );
    vi.mocked(costCentersRepository.findAll).mockResolvedValue([
      existing,
      inactive,
      stale,
    ]);
    const csv = Buffer.from(
      [
        'external_code,name,organizational_unit_code,accepts_assets',
        '4330,Talento Humano,DTH,true',
        '4100,Control Interno,DTH,true',
        '1100,Rectoría,DTH,true',
      ].join('\n'),
    );
    const result = await service.sync(
      { buffer: csv, originalname: 'centros.csv' },
      actor,
    );
    expect(result.created).toBe(1);
    expect(result.updated).toBe(2);
    expect(result.reactivated).toBe(1);
    expect(result.deactivated).toBe(1);
  });

  it('no desactiva un centro con activos', async () => {
    vi.mocked(costCentersRepository.findById).mockResolvedValue(center('4330'));
    vi.mocked(costCentersRepository.countActiveAssets).mockResolvedValue(4);
    await expect(service.remove('cc-4330', actor)).rejects.toMatchObject({
      code: ErrorCode.CostCenterHasActiveAssets,
    });
  });
});
