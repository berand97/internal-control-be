import { OrgRelationType, OrgUnitType } from '../enums/org-unit-type.enum.js';
import { orgChartExportRows } from './org-chart-export.js';
import { planOrgChart } from './org-chart-plan.js';
import { buildOrgChartWorkbook, parseOrgChartWorkbook } from './org-chart-workbook.js';
import type {
  CenterRowInput,
  OrgChartInput,
  OrgChartSnapshot,
  SnapshotCenter,
  SnapshotUnit,
  UnitRowInput,
} from './org-chart.types.js';

const unit = (id: string, code: string, name: string, prefix: string | null, parentId: string | null, type = OrgUnitType.Department): SnapshotUnit => ({
  id,
  code,
  name,
  unitType: type,
  parentId,
  relationType: OrgRelationType.Authority,
  headCostCenterId: null,
  codePrefix: prefix,
  isActive: true,
});

const center = (id: string, code: string, unitId: string | null, parentId: string | null, activeAssets = 0): SnapshotCenter => ({
  id,
  externalCode: code,
  name: `CENTRO ${code}`,
  hasMovement: true,
  isActive: true,
  unitId,
  parentId,
  activeAssets,
});

/** Organigrama coherente con las reglas: 4 → 41, 43; 3 → 30; consejo sin prefijo. */
const baseSnapshot = (): OrgChartSnapshot => ({
  units: [
    unit('u4', 'U4', 'Vicerrectoría Financiera', '4', null, OrgUnitType.Vicerectorate),
    unit('u41', 'U41', 'Departamento Financiero', '41', 'u4'),
    unit('u43', 'U43', 'Departamento de Servicios Administrativos', '43', 'u4'),
    unit('u3', 'U3', 'Vicerrectoría Académica', '3', null, OrgUnitType.Vicerectorate),
    unit('u30', 'U30', 'Departamento de Servicios Educativos', '30', 'u3'),
    { ...unit('cons', 'CONSEJO_SUPERIOR', 'Consejo Superior', null, null, OrgUnitType.Council), relationType: OrgRelationType.Advisory },
  ],
  centers: [
    center('c4010', '4010', 'u4', null),
    center('c4110', '4110', 'u41', null),
    center('c4115', '4115', 'u41', null),
    center('c4350', '4350', 'u43', null, 2),
    center('c4351', '4351', 'u43', 'c4350'),
    center('c4352', '4352', 'u43', 'c4350'),
    center('c3051', '3051', 'u30', null),
  ],
  removal: new Map(),
});

const roundTrip = async (snapshot: OrgChartSnapshot): Promise<OrgChartInput> => {
  const [units, centers] = orgChartExportRows(snapshot.units, snapshot.centers);
  return parseOrgChartWorkbook(await buildOrgChartWorkbook(units, centers, { example: false, generatedAt: new Date() }));
};

const unitRow = (rowNumber: number, values: Partial<UnitRowInput>): UnitRowInput => ({
  rowNumber,
  prefix: null,
  name: null,
  type: null,
  parent: null,
  relation: null,
  headCenter: null,
  status: null,
  action: null,
  code: null,
  ...values,
});

const centerRow = (rowNumber: number, values: Partial<CenterRowInput>): CenterRowInput => ({
  rowNumber,
  code: null,
  name: null,
  movement: null,
  status: null,
  action: null,
  previousCode: null,
  ...values,
});

const only = (input: Partial<OrgChartInput>): OrgChartInput => ({
  units: [],
  centers: [],
  hasUnitSheet: (input.units?.length ?? 0) > 0,
  hasCenterSheet: (input.centers?.length ?? 0) > 0,
  ...input,
});

describe('plan del Excel del organigrama', () => {
  it('exportar y volver a subir sin cambios: 0 cambios, sin errores; avisa 3051 sin 3050', async () => {
    const snapshot = baseSnapshot();
    const input = await roundTrip(snapshot);
    expect(input.units).toHaveLength(6);
    expect(input.centers).toHaveLength(7);
    const plan = planOrgChart(snapshot, input);
    expect(plan.errors).toEqual([]);
    expect(plan.changes).toEqual([]);
    expect(plan.warnings).toEqual([
      expect.objectContaining({ sheet: 'Centros de costo', message: expect.stringContaining('centro padre 3050, que no existe') }),
    ]);
  });

  it('la exportación ordena por árbol y deriva unidad y padre; 4115 es hermano de 4110', () => {
    const [units, centers] = orgChartExportRows(baseSnapshot().units, baseSnapshot().centers);
    expect(units.map((row) => [row.prefix, row.depth, row.parent])).toEqual([
      ['3', 0, null],
      ['30', 1, '3'],
      ['4', 0, null],
      ['41', 1, '4'],
      ['43', 1, '4'],
      [null, 0, null],
    ]);
    const byCode = new Map(centers.map((row) => [row.code, row]));
    expect(byCode.get('4115')).toMatchObject({ parent: null, unit: '41 · Departamento Financiero' });
    expect(byCode.get('4351')).toMatchObject({ parent: '4350', depth: 1 });
  });

  it('renombrar un centro y una unidad', () => {
    const plan = planOrgChart(
      baseSnapshot(),
      only({
        units: [unitRow(2, { prefix: '43', name: 'Dpto. Servicios Administrativos', type: 'Departamento', parent: '4', code: 'U43' })],
        centers: [centerRow(2, { code: '4351', name: 'TESORERÍA AUXILIAR', movement: '1', status: 'Activo' })],
      }),
    );
    expect(plan.errors).toEqual([]);
    expect(plan.unitCounts.RENAMED).toBe(1);
    expect(plan.centerCounts.RENAMED).toBe(1);
    expect(plan.centers[0]).toMatchObject({ key: 'c4351', kinds: ['RENAMED'], unitKey: 'u43', parentKey: 'c4350' });
  });

  it('recodificar con «Código anterior»: el mismo centro pasa al código nuevo y se reubica', () => {
    const plan = planOrgChart(
      baseSnapshot(),
      only({ centers: [centerRow(2, { code: '4121', name: 'CENTRO 4351', previousCode: '4351' })] }),
    );
    expect(plan.errors).toEqual([]);
    expect(plan.centers[0]).toMatchObject({
      key: 'c4351',
      existingId: 'c4351',
      code: '4121',
      previousCode: '4351',
      unitKey: 'u41',
      parentKey: null,
      kinds: ['RECODED', 'RELOCATED'],
    });
    expect(plan.warnings[0]?.message).toContain('centro padre 4120, que no existe');
  });

  it('recodificar a un código que ya existe es error', () => {
    const plan = planOrgChart(baseSnapshot(), only({ centers: [centerRow(2, { code: '4352', name: 'X', previousCode: '4351' })] }));
    expect(plan.errors[0]?.message).toContain('ya es del centro');
  });

  it('eliminar sin historia borra; con historia archiva; con activos es error (409 en el DELETE)', () => {
    const snapshot = { ...baseSnapshot(), removal: new Map([['c4352', { history: 'Se archiva porque tiene historia: 3 movimientos de activos' }]]) };
    const plan = planOrgChart(
      snapshot,
      only({
        centers: [
          centerRow(2, { code: '4351', name: 'CENTRO 4351', action: 'ELIMINAR' }),
          centerRow(3, { code: '4352', name: 'CENTRO 4352', action: 'ELIMINAR' }),
          centerRow(4, { code: '4350', name: 'CENTRO 4350', action: 'ARCHIVAR' }),
        ],
      }),
    );
    expect(plan.centers.find((op) => op.key === 'c4351')).toMatchObject({ removal: 'DELETE', kinds: ['DELETED'] });
    expect(plan.centers.find((op) => op.key === 'c4352')).toMatchObject({ removal: 'ARCHIVE', kinds: ['ARCHIVED'] });
    expect(plan.errors).toEqual([expect.objectContaining({ rowNumber: 4, message: 'Tiene 2 activos asignados: no se puede eliminar ni archivar' })]);
  });

  it('un centro con hijos activos que no están en el archivo no se archiva', () => {
    const snapshot = baseSnapshot();
    const plan = planOrgChart(
      { ...snapshot, centers: snapshot.centers.map((item) => (item.id === 'c4350' ? { ...item, activeAssets: 0 } : item)) },
      only({ centers: [centerRow(2, { code: '4350', name: 'CENTRO 4350', action: 'ARCHIVAR' })] }),
    );
    expect(plan.errors[0]?.message).toContain('Tiene 2 centros hijos activos (4351, 4352)');
  });

  it('unidad nueva con prefijo fuera del de su padre: ORG_UNIT_PREFIX_OUT_OF_PARENT en español', () => {
    const plan = planOrgChart(
      baseSnapshot(),
      only({ units: [unitRow(2, { prefix: '53', name: 'Oficina X', type: 'Oficina', parent: '4' })] }),
    );
    expect(plan.errors[0]).toMatchObject({
      column: 'Prefijo',
      message: expect.stringContaining('debe ser 4 seguido de un dígito (40–49)'),
    });
  });

  it('unidad nueva bajo 4 con centros nuevos: los centros quedan en ella y con su padre', () => {
    const plan = planOrgChart(
      baseSnapshot(),
      only({
        units: [unitRow(2, { prefix: '45', name: 'Departamento de Contabilidad', type: 'Departamento', parent: '4', headCenter: '4510' })],
        centers: [centerRow(2, { code: '4510', name: 'CONTABILIDAD' }), centerRow(3, { code: '4511', name: 'NÓMINA' })],
      }),
    );
    expect(plan.errors).toEqual([]);
    expect(plan.units[0]).toMatchObject({ key: 'new:U45', code: 'U45', parentKey: 'u4', headCenterKey: 'new:4510' });
    expect(plan.centers.map((op) => [op.code, op.unitKey, op.parentKey])).toEqual([
      ['4510', 'new:U45', null],
      ['4511', 'new:U45', 'new:4510'],
    ]);
  });

  it('unidad con centros activos no se elimina; un consejo no lleva prefijo', () => {
    const plan = planOrgChart(
      baseSnapshot(),
      only({
        units: [
          unitRow(2, { prefix: '41', name: 'Departamento Financiero', type: 'Departamento', parent: '4', code: 'U41', action: 'ELIMINAR' }),
          unitRow(3, { prefix: '6', name: 'Consejo Superior', type: 'Consejo o comité', code: 'CONSEJO_SUPERIOR' }),
        ],
      }),
    );
    expect(plan.errors.map((issue) => issue.message)).toEqual([
      'Un consejo o comité no lleva prefijo: no recibe centros de costo',
      'Tiene 2 centros de costo activos: muévalos o márquelos también',
    ]);
  });

  it('filas que no están en el archivo no se tocan', () => {
    const plan = planOrgChart(baseSnapshot(), only({ centers: [centerRow(2, { code: '4110', name: 'CENTRO 4110' })] }));
    expect(plan.changes).toEqual([]);
  });
});
