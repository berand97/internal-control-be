import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import { Campus } from '../../campus/entities/campus.entity.js';
import { Building } from '../entities/building.entity.js';
import type { BuildingsRepository } from '../repositories/buildings.repository.interface.js';
import { BuildingsService } from './buildings.service.js';

const actor: AuthenticatedUser = {
  id: 'admin-1',
  personId: 'person-1',
  username: 'admin',
  roles: ['SUPER_ADMIN'],
  scopes: [{ type: 'GLOBAL', id: null }],
};

const campus = (): Campus => {
  const item = new Campus();
  item.id = 'campus-1';
  item.code = 'MED';
  item.name = 'Medellín';
  item.isActive = true;
  return item;
};

const building = (): Building => {
  const item = new Building();
  item.id = 'building-1';
  item.campusId = 'campus-1';
  item.code = 'A';
  item.name = 'Bloque A';
  item.floorsCount = 4;
  item.isActive = true;
  return item;
};

describe('BuildingsService', () => {
  let buildingsRepository: BuildingsRepository;
  let service: BuildingsService;

  beforeEach(() => {
    buildingsRepository = {
      findByCampus: vi.fn(),
      findById: vi.fn(),
      findCampusById: vi.fn().mockResolvedValue(campus()),
      insert: vi.fn(),
      update: vi.fn(),
      deactivate: vi.fn(),
      countLocations: vi.fn().mockResolvedValue(0),
    };
    const auditLogsRepository: AuditLogsRepository = {
      record: vi.fn().mockResolvedValue(undefined),
      findLastLogins: vi.fn(),
    };
    service = new BuildingsService(buildingsRepository, auditLogsRepository);
  });

  it('rechaza código duplicado por campus', async () => {
    const { QueryFailedError } = await import('typeorm');
    const error = new QueryFailedError('INSERT', [], {
      code: '23505',
    } as never);
    vi.mocked(buildingsRepository.insert).mockRejectedValue(error);
    await expect(
      service.create('campus-1', { code: 'A', name: 'Bloque A' }, actor),
    ).rejects.toMatchObject({ code: ErrorCode.BuildingCodeAlreadyExists });
  });

  it('no elimina un edificio con ubicaciones', async () => {
    vi.mocked(buildingsRepository.findById).mockResolvedValue(building());
    vi.mocked(buildingsRepository.countLocations).mockResolvedValue(3);
    await expect(
      service.remove('campus-1', 'building-1', actor),
    ).rejects.toMatchObject({ code: ErrorCode.HasDependentEntities });
  });
});
