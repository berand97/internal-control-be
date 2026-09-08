import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import { Campus } from '../entities/campus.entity.js';
import type { CampusRepository } from '../repositories/campus.repository.interface.js';
import { CampusService } from './campus.service.js';

const actor: AuthenticatedUser = {
  id: 'admin-1',
  personId: 'person-1',
  username: 'admin',
  roles: ['SUPER_ADMIN'],
  scopes: [{ type: 'GLOBAL', id: null }],
};

const medellin = (): Campus => {
  const campus = new Campus();
  campus.id = 'campus-1';
  campus.code = 'MED';
  campus.name = 'Campus Medellín';
  campus.address = null;
  campus.city = 'Medellín';
  campus.department = 'Antioquia';
  campus.country = 'Colombia';
  campus.isActive = true;
  campus.createdAt = new Date();
  campus.updatedAt = new Date();
  return campus;
};

describe('CampusService', () => {
  let campusRepository: CampusRepository;
  let auditLogsRepository: AuditLogsRepository;
  let service: CampusService;

  beforeEach(() => {
    campusRepository = {
      findAll: vi.fn(),
      findById: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      deactivate: vi.fn(),
      countBuildings: vi.fn().mockResolvedValue(0),
    };
    auditLogsRepository = {
      record: vi.fn().mockResolvedValue(undefined),
      findLastLogins: vi.fn(),
    };
    service = new CampusService(campusRepository, auditLogsRepository);
  });

  it('crea un campus', async () => {
    const created = medellin();
    vi.mocked(campusRepository.insert).mockResolvedValue(created);
    const result = await service.create({ code: 'MED', name: 'Campus Medellín' }, actor);
    expect(result.code).toBe('MED');
  });

  it('no elimina un campus con edificios', async () => {
    vi.mocked(campusRepository.findById).mockResolvedValue(medellin());
    vi.mocked(campusRepository.countBuildings).mockResolvedValue(2);
    await expect(service.remove('campus-1', actor)).rejects.toMatchObject({
      code: ErrorCode.HasDependentEntities,
    });
  });
});
