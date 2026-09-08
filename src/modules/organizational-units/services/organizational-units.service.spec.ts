import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import { OrganizationalUnit } from '../entities/organizational-unit.entity.js';
import { OrgUnitType } from '../enums/org-unit-type.enum.js';
import type { OrganizationalUnitsRepository } from '../repositories/organizational-units.repository.interface.js';
import { OrganizationalUnitsService } from './organizational-units.service.js';

const actor: AuthenticatedUser = {
  id: 'admin-1',
  personId: 'person-1',
  username: 'admin',
  roles: ['SUPER_ADMIN'],
  scopes: [{ type: 'GLOBAL', id: null }],
};

const unit = (
  id: string,
  code: string,
  parentId: string | null,
  level: number,
): OrganizationalUnit => {
  const item = new OrganizationalUnit();
  item.id = id;
  item.code = code;
  item.name = code;
  item.unitType = OrgUnitType.Department;
  item.parentId = parentId;
  item.hierarchyLevel = level;
  item.hierarchyPath = parentId ? `/rec/${code.toLowerCase()}` : `/${code.toLowerCase()}`;
  item.isActive = true;
  return item;
};

describe('OrganizationalUnitsService', () => {
  let unitsRepository: OrganizationalUnitsRepository;
  let service: OrganizationalUnitsService;

  beforeEach(() => {
    unitsRepository = {
      findAll: vi.fn(),
      findById: vi.fn(),
      findActiveById: vi.fn(),
      findByCode: vi.fn(),
      findChildren: vi.fn(),
      countActiveChildren: vi.fn().mockResolvedValue(0),
      countCostCenters: vi.fn().mockResolvedValue(0),
      insert: vi.fn(),
      update: vi.fn(),
      deactivate: vi.fn(),
      rewriteDescendantPaths: vi.fn(),
    };
    const auditLogsRepository: AuditLogsRepository = {
      record: vi.fn().mockResolvedValue(undefined),
      findLastLogins: vi.fn(),
    };
    service = new OrganizationalUnitsService(
      unitsRepository,
      auditLogsRepository,
    );
  });

  it('arma un árbol de tres niveles', async () => {
    const rec = unit('1', 'REC', null, 0);
    rec.unitType = OrgUnitType.Rectorate;
    const vac = unit('2', 'VAC', '1', 1);
    vac.unitType = OrgUnitType.Vicerectorate;
    const fing = unit('3', 'FING', '2', 2);
    fing.unitType = OrgUnitType.Faculty;
    vi.mocked(unitsRepository.findAll).mockResolvedValue([rec, vac, fing]);
    const tree = await service.tree();
    expect(tree).toHaveLength(1);
    expect(tree[0]?.children[0]?.children[0]?.code).toBe('FING');
  });

  it('bloquea un ciclo al reparentar hacia un descendiente', async () => {
    const rec = unit('1', 'REC', null, 0);
    const vac = unit('2', 'VAC', '1', 1);
    vi.mocked(unitsRepository.findById).mockImplementation(async (id) => {
      if (id === '1') {
        return rec;
      }
      if (id === '2') {
        return vac;
      }
      return null;
    });
    await expect(
      service.update('1', { parentId: '2' }, actor),
    ).rejects.toMatchObject({ code: ErrorCode.OrgUnitCycle });
  });

  it('edita el nombre y mueve la unidad a otra dependencia', async () => {
    const rec = unit('1', 'REC', null, 0);
    rec.hierarchyPath = '/rec';
    const vac = unit('2', 'VAC', '1', 1);
    vac.hierarchyPath = '/rec/vac';
    vac.unitType = OrgUnitType.Vicerectorate;
    const vad = unit('3', 'VAD', '1', 1);
    vad.hierarchyPath = '/rec/vad';
    vad.unitType = OrgUnitType.Vicerectorate;
    const dci = unit('4', 'DCI', '3', 2);
    dci.hierarchyPath = '/rec/vad/dci';
    dci.name = 'Control Interno';

    vi.mocked(unitsRepository.findById).mockImplementation(async (id) => {
      if (id === '1') {
        return rec;
      }
      if (id === '2') {
        return vac;
      }
      if (id === '3') {
        return vad;
      }
      if (id === '4') {
        return dci;
      }
      return null;
    });

    const result = await service.update(
      '4',
      { name: 'Departamento de Control Interno', parentId: '2' },
      actor,
    );

    expect(unitsRepository.update).toHaveBeenCalledWith(
      '4',
      expect.objectContaining({
        name: 'Departamento de Control Interno',
        parentId: '2',
        hierarchyPath: '/rec/vac/dci',
        hierarchyLevel: 2,
      }),
    );
    expect(unitsRepository.rewriteDescendantPaths).toHaveBeenCalledWith(
      '/rec/vad/dci',
      '/rec/vac/dci',
      0,
    );
    expect(result.code).toBe('DCI');
  });

  it('mueve una unidad a la raíz con parentId null', async () => {
    const rec = unit('1', 'REC', null, 0);
    rec.hierarchyPath = '/rec';
    const vad = unit('3', 'VAD', '1', 1);
    vad.hierarchyPath = '/rec/vad';
    const dci = unit('4', 'DCI', '3', 2);
    dci.hierarchyPath = '/rec/vad/dci';

    vi.mocked(unitsRepository.findById).mockImplementation(async (id) => {
      if (id === '1') {
        return rec;
      }
      if (id === '3') {
        return vad;
      }
      if (id === '4') {
        return dci;
      }
      return null;
    });

    await service.update('4', { parentId: null }, actor);

    expect(unitsRepository.update).toHaveBeenCalledWith(
      '4',
      expect.objectContaining({
        parentId: null,
        hierarchyPath: '/dci',
        hierarchyLevel: 0,
      }),
    );
    expect(unitsRepository.rewriteDescendantPaths).toHaveBeenCalledWith(
      '/rec/vad/dci',
      '/dci',
      -2,
    );
  });

  it('no desactiva una unidad con hijos activos', async () => {
    vi.mocked(unitsRepository.findById).mockResolvedValue(unit('1', 'REC', null, 0));
    vi.mocked(unitsRepository.countActiveChildren).mockResolvedValue(2);
    await expect(service.remove('1', actor)).rejects.toMatchObject({
      code: ErrorCode.OrgUnitHasChildren,
    });
  });
});
