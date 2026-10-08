import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import { OrganizationalUnit } from '../entities/organizational-unit.entity.js';
import { OrgUnitType } from '../enums/org-unit-type.enum.js';
import type { OrganizationalUnitsRepository } from '../repositories/organizational-units.repository.interface.js';
import type { DataSource } from 'typeorm';
import type { OrgStructureHistoryService } from '../../cost-centers/services/org-structure-history.service.js';
import type { StructureRemovalService, UnitRemovalCheck } from '../../cost-centers/services/structure-removal.service.js';
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
  let removal: { inspectUnit: ReturnType<typeof vi.fn>; deleteUnit: ReturnType<typeof vi.fn> };
  let manager: { query: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    unitsRepository = {
      findAll: vi.fn(),
      findById: vi.fn(),
      findActiveById: vi.fn(),
      findByCode: vi.fn(),
      findActiveByCodePrefix: vi.fn().mockResolvedValue(null),
      findChildren: vi.fn(),
      countActiveChildren: vi.fn().mockResolvedValue(0),
      countActiveCostCenters: vi.fn().mockResolvedValue(0),
      costCenterExists: vi.fn().mockResolvedValue(true),
      costCenterCode: vi.fn().mockResolvedValue('4010'),
      findCostCenterByCode: vi.fn().mockResolvedValue(null),
      insert: vi.fn(),
      update: vi.fn(),
      deactivate: vi.fn(),
      rewriteDescendantPaths: vi.fn(),
    };
    const auditLogsRepository: AuditLogsRepository = {
      record: vi.fn().mockResolvedValue(undefined),
      findLastLogins: vi.fn(),
    };
    manager = { query: vi.fn().mockResolvedValue([]) };
    const dataSource = {
      manager,
      transaction: vi.fn(async (work: (m: typeof manager) => Promise<unknown>) => work(manager)),
    } as unknown as DataSource;
    const noReferences: UnitRemovalCheck = { activeChildren: 0, activeCenters: 0, references: [] };
    removal = { inspectUnit: vi.fn().mockResolvedValue(noReferences), deleteUnit: vi.fn() };
    const history = { record: vi.fn().mockResolvedValue(0) } as unknown as OrgStructureHistoryService;
    service = new OrganizationalUnitsService(
      unitsRepository,
      auditLogsRepository,
      dataSource,
      removal as unknown as StructureRemovalService,
      history,
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

  it('no desactiva una unidad con centros activos y dice cuántos', async () => {
    vi.mocked(unitsRepository.findById).mockResolvedValue(unit('1', 'REC', null, 0));
    vi.mocked(unitsRepository.countActiveCostCenters).mockResolvedValue(3);
    await expect(service.remove('1', actor)).rejects.toMatchObject({
      code: ErrorCode.HasDependentEntities,
      message: 'La unidad tiene 3 centros de costo activos: muévalos a otra unidad o desactívelos antes de desactivar la unidad',
      details: [{ field: 'activeCostCenters', message: '3' }],
    });
    expect(unitsRepository.deactivate).not.toHaveBeenCalled();
  });

  it('archiva una unidad cuyos centros están todos inactivos (los centros la referencian)', async () => {
    vi.mocked(unitsRepository.findById).mockResolvedValue(unit('1', 'REC', null, 0));
    removal.inspectUnit.mockResolvedValue({
      activeChildren: 0,
      activeCenters: 0,
      references: [{ table: 'cost_center', column: 'organizational_unit_id', label: 'centros de costo (inactivos)', count: 2 }],
    });
    await expect(service.remove('1', actor)).resolves.toEqual({
      deleted: false,
      archived: true,
      reason: 'Se archiva porque tiene historia: 2 centros de costo (inactivos)',
    });
    expect(unitsRepository.countActiveCostCenters).toHaveBeenCalledWith('1');
    expect(manager.query).toHaveBeenCalledWith(expect.stringContaining('SET is_active = FALSE'), ['1']);
    expect(removal.deleteUnit).not.toHaveBeenCalled();
  });

  it('borra de verdad una unidad sin nada que la referencie', async () => {
    vi.mocked(unitsRepository.findById).mockResolvedValue(unit('1', 'REC', null, 0));
    await expect(service.remove('1', actor)).resolves.toEqual({ deleted: true, archived: false, reason: null });
    expect(removal.deleteUnit).toHaveBeenCalledWith(manager, '1');
  });

  it('el prefijo de una hija empieza por el del padre y es más largo: ORG_UNIT_PREFIX_OUT_OF_PARENT', async () => {
    const vice = unit('1', 'VF', null, 0);
    vice.codePrefix = '4';
    vi.mocked(unitsRepository.findById).mockResolvedValue(vice);
    const bienestar = unit('5', 'VB', null, 0);
    bienestar.codePrefix = '5';
    vi.mocked(unitsRepository.findAll).mockResolvedValue([vice, bienestar]);
    await expect(
      service.create({ code: 'DSA', name: 'Servicios', type: OrgUnitType.Department, parentId: '1', codePrefix: '53' }, actor),
    ).rejects.toMatchObject({
      code: ErrorCode.OrgUnitPrefixOutOfParent,
      message: expect.stringContaining('El prefijo 53 no empieza por el de su jefe (4) y los números 5… son de'),
      details: [{ field: 'codePrefix', message: '4…' }],
    });
    vi.mocked(unitsRepository.insert).mockImplementation(async (record) => Object.assign(new OrganizationalUnit(), { id: '9', ...record }));
    await expect(
      service.create({ code: 'DSA', name: 'Servicios', type: OrgUnitType.Department, parentId: '1', codePrefix: '43' }, actor),
    ).resolves.toMatchObject({ codePrefix: '43', parentId: '1' });
    await expect(
      service.create({ code: 'LOG', name: 'Logística', type: OrgUnitType.Department, parentId: '1', codePrefix: '4115' }, actor),
    ).resolves.toMatchObject({ codePrefix: '4115', parentId: '1' });
  });

  it('un consejo no lleva prefijo', async () => {
    await expect(
      service.create({ code: 'CS', name: 'Consejo Superior', type: OrgUnitType.Council, codePrefix: '7' }, actor),
    ).rejects.toMatchObject({ code: ErrorCode.ValidationFailed });
  });
});
