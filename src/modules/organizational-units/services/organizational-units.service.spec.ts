import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import { OrganizationalUnit } from '../entities/organizational-unit.entity.js';
import { OrgUnitType } from '../enums/org-unit-type.enum.js';
import type { OrganizationalUnitsRepository } from '../repositories/organizational-units.repository.interface.js';
import type { DataSource } from 'typeorm';
import type { OrgStructureHistoryService } from '../../cost-centers/services/org-structure-history.service.js';
import type { StructureReconcilerService } from '../../cost-centers/services/structure-reconciler.service.js';
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
  let reconciler: { reconcileWithin: ReturnType<typeof vi.fn> };
  let historyRecord: ReturnType<typeof vi.fn>;

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
    historyRecord = vi.fn().mockResolvedValue(0);
    const history = { record: historyRecord } as unknown as OrgStructureHistoryService;
    reconciler = { reconcileWithin: vi.fn().mockResolvedValue({}) };
    service = new OrganizationalUnitsService(
      unitsRepository,
      auditLogsRepository,
      dataSource,
      removal as unknown as StructureRemovalService,
      history,
      reconciler as unknown as StructureReconcilerService,
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
      expect.anything(),
    );
    expect(unitsRepository.rewriteDescendantPaths).toHaveBeenCalledWith(
      '/rec/vad/dci',
      '/rec/vac/dci',
      0,
      expect.anything(),
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
      expect.anything(),
    );
    expect(unitsRepository.rewriteDescendantPaths).toHaveBeenCalledWith(
      '/rec/vad/dci',
      '/dci',
      -2,
      expect.anything(),
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

  it('prefijo fuera del jefe: advertencia, nunca error; el mismo del jefe: ORG_UNIT_PREFIX_OUT_OF_PARENT', async () => {
    const vice = unit('1', 'VF', null, 0);
    vice.codePrefix = '4';
    vi.mocked(unitsRepository.findById).mockResolvedValue(vice);
    const bienestar = unit('5', 'VB', null, 0);
    bienestar.codePrefix = '5';
    vi.mocked(unitsRepository.findAll).mockResolvedValue([vice, bienestar]);
    vi.mocked(unitsRepository.insert).mockImplementation(async (record) => Object.assign(new OrganizationalUnit(), { id: '9', ...record }));
    await expect(
      service.create({ code: 'DSA', name: 'Servicios', type: OrgUnitType.Department, parentId: '1', codePrefix: '53' }, actor),
    ).resolves.toMatchObject({
      codePrefix: '53',
      warnings: ['Servicios (53) depende de VF (4) pero conserva los códigos 53… de VB'],
    });
    const contabilidad = unit('43', 'CONT', '1', 1);
    contabilidad.codePrefix = '43';
    vi.mocked(unitsRepository.findById).mockResolvedValue(contabilidad);
    await expect(
      service.create({ code: 'CI', name: 'Control', type: OrgUnitType.Department, parentId: '43', codePrefix: '43' }, actor),
    ).rejects.toMatchObject({ code: ErrorCode.OrgUnitPrefixOutOfParent, details: [{ field: 'codePrefix', message: '43…' }] });
    vi.mocked(unitsRepository.findById).mockResolvedValue(vice);
    await expect(
      service.create({ code: 'DSA', name: 'Servicios', type: OrgUnitType.Department, parentId: '1', codePrefix: '43' }, actor),
    ).resolves.toMatchObject({ codePrefix: '43', parentId: '1' });
    await expect(
      service.create({ code: 'LOG', name: 'Logística', type: OrgUnitType.Department, parentId: '1', codePrefix: '4115' }, actor),
    ).resolves.toMatchObject({ codePrefix: '4115', parentId: '1' });
  });

  it('árbol: color propio y effectiveColor heredado del ancestro más cercano con color', async () => {
    const rec = unit('1', 'REC', null, 0);
    const vf = unit('2', 'VF', '1', 1);
    vf.color = '#de9927';
    const cont = unit('3', 'CONT', '2', 2);
    const caja = unit('4', 'CAJA', '3', 3);
    caja.color = '#29b1b2';
    const tes = unit('5', 'TES', '4', 4);
    for (const item of [rec, cont, tes]) {
      item.color = null;
    }
    vi.mocked(unitsRepository.findAll).mockResolvedValue([rec, vf, cont, caja, tes]);
    const [root] = await service.tree(true);
    const vfNode = root?.children[0];
    const contNode = vfNode?.children[0];
    const cajaNode = contNode?.children[0];
    expect(root).toMatchObject({ color: null, effectiveColor: null });
    expect(vfNode).toMatchObject({ color: '#de9927', effectiveColor: '#de9927' });
    expect(contNode).toMatchObject({ color: null, effectiveColor: '#de9927' });
    expect(cajaNode).toMatchObject({ color: '#29b1b2', effectiveColor: '#29b1b2' });
    expect(cajaNode?.children[0]).toMatchObject({ color: null, effectiveColor: '#29b1b2' });
    expect(unitsRepository.findAll).toHaveBeenCalledWith(undefined);
  });

  it('subárbol: effectiveColor toma el color de ancestros que no vienen en la respuesta', async () => {
    const vf = unit('2', 'VF', null, 0);
    vf.color = '#de9927';
    const cont = unit('3', 'CONT', '2', 1);
    cont.color = null;
    const caja = unit('4', 'CAJA', '3', 2);
    caja.color = null;
    vi.mocked(unitsRepository.findById).mockResolvedValue(cont);
    vi.mocked(unitsRepository.findAll).mockResolvedValue([vf, cont, caja]);
    const nodes = await service.descendants('3');
    expect(nodes[0]).toMatchObject({ code: 'CAJA', color: null, effectiveColor: '#de9927' });
  });

  it('cambiar o quitar el color lo guarda y lo deja en el historial (COLOR)', async () => {
    const vf = unit('2', 'VF', null, 0);
    vf.hierarchyPath = '/vf';
    vf.color = '#de9927';
    vi.mocked(unitsRepository.findById).mockResolvedValue(vf);
    await service.update('2', { color: '#29b1b2' }, actor);
    expect(unitsRepository.update).toHaveBeenCalledWith('2', expect.objectContaining({ color: '#29b1b2' }), expect.anything());
    expect(historyRecord).toHaveBeenLastCalledWith(
      manager,
      expect.arrayContaining([{ entityType: 'ORG_UNIT', entityId: '2', field: 'COLOR', oldValue: '#de9927', newValue: '#29b1b2' }]),
      { actorId: 'admin-1', source: 'MANUAL' },
    );
    await service.update('2', { color: null }, actor);
    expect(unitsRepository.update).toHaveBeenLastCalledWith('2', expect.objectContaining({ color: null }), expect.anything());
    expect(historyRecord).toHaveBeenLastCalledWith(
      manager,
      expect.arrayContaining([{ entityType: 'ORG_UNIT', entityId: '2', field: 'COLOR', oldValue: '#de9927', newValue: null }]),
      expect.anything(),
    );
    // Omitido: no se toca.
    await service.update('2', { name: 'Vicerrectoría Financiera' }, actor);
    expect(unitsRepository.update).toHaveBeenLastCalledWith('2', expect.not.objectContaining({ color: expect.anything() }), expect.anything());
  });

  it('crea con color (o sin color: null)', async () => {
    vi.mocked(unitsRepository.insert).mockImplementation(async (record) => Object.assign(new OrganizationalUnit(), { id: '9', ...record }));
    await expect(
      service.create({ code: 'VF', name: 'Vicerrectoría Financiera', type: OrgUnitType.Vicerectorate, color: '#de9927' }, actor),
    ).resolves.toMatchObject({ color: '#de9927' });
    await expect(
      service.create({ code: 'VA', name: 'Vicerrectoría Académica', type: OrgUnitType.Vicerectorate }, actor),
    ).resolves.toMatchObject({ color: null });
  });

  it('un consejo no lleva prefijo', async () => {
    await expect(
      service.create({ code: 'CS', name: 'Consejo Superior', type: OrgUnitType.Council, codePrefix: '7' }, actor),
    ).rejects.toMatchObject({ code: ErrorCode.ValidationFailed });
  });
});
