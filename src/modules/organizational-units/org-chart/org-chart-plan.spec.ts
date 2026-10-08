import ExcelJS from 'exceljs';
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
      only({
        units: [
          unitRow(2, { prefix: '33', name: 'Oficina X', type: 'Oficina', parent: '4' }),
          unitRow(3, { prefix: '53', name: 'Oficina Y', type: 'Oficina', parent: '4' }),
        ],
      }),
    );
    expect(plan.errors).toEqual([
      expect.objectContaining({
        rowNumber: 2,
        column: 'Prefijo',
        message: 'El prefijo 33 no empieza por el de su jefe (4) y los números 3… son de Vicerrectoría Académica',
      }),
    ]);
    // Ninguna unidad tiene el «5»: se acepta con advertencia (como 30 bajo la Académica).
    expect(plan.warnings).toEqual([expect.objectContaining({ rowNumber: 3, message: expect.stringContaining('se acepta') })]);
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

  it('códigos internos que solo difieren en mayúsculas son unidades distintas (ida y vuelta sin cambios)', async () => {
    const snapshot = baseSnapshot();
    const withCase = {
      ...snapshot,
      units: [...snapshot.units, unit('low', 'S24c5809', 'Unidad de prueba', null, null), unit('up', 'S24C5809', 'Unidad de prueba', null, null)],
    };
    const plan = planOrgChart(withCase, await roundTrip(withCase));
    expect(plan.errors).toEqual([]);
    expect(plan.changes).toEqual([]);
  });

  describe('columnas vacías: se conserva o se deduce', () => {
    const withHead = (): OrgChartSnapshot => {
      const snapshot = baseSnapshot();
      return {
        ...snapshot,
        units: snapshot.units.map((item) =>
          item.id === 'u43' ? { ...item, headCostCenterId: 'c4350', relationType: OrgRelationType.Coordination } : item,
        ),
      };
    };

    it('ida y vuelta con centro propio y línea no Autoridad: 0 cambios', async () => {
      const snapshot = withHead();
      const plan = planOrgChart(snapshot, await roundTrip(snapshot));
      expect(plan.errors).toEqual([]);
      expect(plan.changes).toEqual([]);
    });

    it('unidad existente con padre y Depende de, Línea, Centro propio y Estado vacíos: sin cambios', () => {
      const plan = planOrgChart(
        withHead(),
        only({ units: [unitRow(2, { prefix: '43', name: 'Departamento de Servicios Administrativos', code: 'U43' })] }),
      );
      expect(plan.errors).toEqual([]);
      expect(plan.warnings).toEqual([]);
      expect(plan.changes).toEqual([]);
    });

    it('«RAÍZ» (o raiz) en Depende de vuelve raíz a la unidad', () => {
      const plan = planOrgChart(
        baseSnapshot(),
        only({
          units: [
            unitRow(2, { prefix: '43', name: 'Departamento de Servicios Administrativos', code: 'U43', parent: 'RAÍZ' }),
            unitRow(3, { prefix: '41', name: 'Departamento Financiero', code: 'U41', parent: 'raiz' }),
          ],
        }),
      );
      expect(plan.errors).toEqual([]);
      expect(plan.units.map((op) => [op.key, op.parentKey, op.kinds])).toEqual([
        ['u43', null, ['MOVED']],
        ['u41', null, ['MOVED']],
      ]);
    });

    it('«NINGUNO» en Centro propio se lo quita', () => {
      const plan = planOrgChart(
        withHead(),
        only({ units: [unitRow(2, { prefix: '43', name: 'Departamento de Servicios Administrativos', code: 'U43', headCenter: 'NINGUNO' })] }),
      );
      expect(plan.errors).toEqual([]);
      expect(plan.units[0]).toMatchObject({ key: 'u43', headCenterKey: null, kinds: ['HEAD_CHANGED'] });
    });

    it('nueva 44 sin Depende de queda bajo 4; 461 bajo la 46 nueva del archivo; Línea vacía = Autoridad', () => {
      const plan = planOrgChart(
        baseSnapshot(),
        only({
          units: [
            unitRow(2, { prefix: '44', name: 'Oficina de Compras', type: 'Oficina' }),
            unitRow(3, { prefix: '46', name: 'Departamento de Contabilidad', type: 'Departamento', parent: '4' }),
            unitRow(4, { prefix: '461', name: 'Sección de Nómina', type: 'Oficina' }),
            unitRow(5, { prefix: '431', name: 'Sección de Archivo', type: 'Oficina' }),
          ],
        }),
      );
      expect(plan.errors).toEqual([]);
      expect(plan.units.map((op) => [op.code, op.parentKey, op.relationType])).toEqual([
        ['U44', 'u4', OrgRelationType.Authority],
        ['U46', 'u4', OrgRelationType.Authority],
        ['U461', 'new:U46', OrgRelationType.Authority],
        ['U431', 'u43', OrgRelationType.Authority],
      ]);
      expect(plan.changes[0]?.detail).toContain('bajo 4 · Vicerrectoría Financiera');
      expect(plan.warnings.map((issue) => [issue.rowNumber, issue.column, issue.message])).toEqual([
        [2, 'Depende de', 'Depende de deducido del prefijo: 4'],
        [4, 'Depende de', 'Depende de deducido del prefijo: 46'],
        [5, 'Depende de', 'Depende de deducido del prefijo: 43'],
      ]);
    });

    it('nueva de un dígito: bajo la única Rectoría activa y con su centro X010 como centro propio', () => {
      const snapshot = baseSnapshot();
      const plan = planOrgChart(
        { ...snapshot, units: [...snapshot.units, unit('u1', 'U1', 'Rectoría', '1', null, OrgUnitType.Rectorate)] },
        only({
          units: [unitRow(2, { prefix: '5', name: 'Vicerrectoría de Bienestar', type: 'Vicerrectoría' })],
          centers: [centerRow(2, { code: '5010', name: 'VICERRECTORÍA DE BIENESTAR' })],
        }),
      );
      expect(plan.errors).toEqual([]);
      expect(plan.units[0]).toMatchObject({ code: 'U5', parentKey: 'u1', headCenterKey: 'new:5010' });
      expect(plan.warnings.map((issue) => issue.message)).toEqual([
        'Depende de deducido: la Rectoría 1',
        'Centro propio deducido: 5010',
      ]);
    });

    it('nueva de un dígito sin Rectoría (o con dos) y nueva sin prefijo: raíz con advertencia; sin X010 no hay centro propio', () => {
      const snapshot = baseSnapshot();
      const rectorates = [unit('r1', 'R1', 'Rectoría A', '1', null, OrgUnitType.Rectorate), unit('r2', 'R2', 'Rectoría B', '2', null, OrgUnitType.Rectorate)];
      for (const extra of [[], rectorates]) {
        const plan = planOrgChart(
          { ...snapshot, units: [...snapshot.units, ...extra] },
          only({
            units: [
              unitRow(2, { prefix: '5', name: 'Vicerrectoría de Bienestar', type: 'Vicerrectoría' }),
              unitRow(3, { name: 'Consejo Académico', type: 'Consejo o comité' }),
            ],
          }),
        );
        expect(plan.errors).toEqual([]);
        expect(plan.units.map((op) => [op.code, op.parentKey, op.headCenterKey])).toEqual([
          ['U5', null, null],
          ['CONSEJO_ACADEMICO', null, null],
        ]);
        expect(plan.warnings.map((issue) => [issue.rowNumber, issue.message])).toEqual([
          [2, 'Sin Depende de: queda en la raíz'],
          [3, 'Sin Depende de: queda en la raíz'],
        ]);
      }
    });
  });

  describe('códigos de 4 dígitos de Contabilidad en la hoja Organigrama (como la llena Control Interno)', () => {
    /** Hoja real de Control Interno: Prefijo con el código de Contabilidad y Depende de con el del jefe. */
    const MONICA_ROWS: ReadonlyArray<[string, string, string, string, string]> = [
      ['1', 'RECTORÍA', 'Rectoría', '', 'Autoridad'],
      ['2', 'VICERRECTORÍA ACADÉMICA', 'Vicerrectoría', '1', 'Autoridad'],
      ['4', 'VICERRECTORÍA FINANCIERA', 'Vicerrectoría', '1', 'Autoridad'],
      ['5', 'VICERRECTORÍA BIENESTAR UNIVERSITARIO', 'Vicerrectoría', '1', 'Autoridad'],
      ['9', 'INSTITUCIONAL', 'Otro', '1', 'Autoridad'],
      ['1100', 'Rectoría', 'Rectoría', '1', 'Asesoría'],
      ['1110', 'OFICINA JURÍDICA', 'Oficina', '1100', 'Asesoría'],
      ['1200', 'DEPARTAMENTO DE PLANEACIÓN E INTERNACIONALIZACIÓN', 'Departamento', '1', 'Asesoría'],
      ['1210', 'PLANEACIÓN', 'Departamento', '1200', 'Asesoría'],
      ['1220', 'INTERNACIONALIZACIÓN', 'Departamento', '1200', 'Asesoría'],
      ['1300', 'OFICINA DE IMAGEN INSTITUCIONAL, RELACIONES PÚBLICAS Y PRENSA', 'Oficina', '1', 'Asesoría'],
      ['1310', 'OFICINA DE IMAGEN INSTITUCIONAL, RELACIONES PÚBLICAS Y PRENSA', 'Oficina', '1300', 'Asesoría'],
      ['1400', 'DEPARTAMENTO DE CAPTACIÓN DE RECURSOS', 'Departamento', '1', 'Asesoría'],
      ['1410', 'DEPARTAMENTO DE CAPTACIÓN DE RECURSOS', 'Departamento', '1400', 'Asesoría'],
      ['1500', 'SECRETARÍA GENERAL', 'Departamento', '1', 'Asesoría'],
      ['1510', 'SECRETARÍA GENERAL', 'Departamento', '1500', 'Asesoría'],
      ['1520', 'OFICINA DE ADMISIONES Y REGISTRO', 'Oficina', '1500', 'Asesoría'],
      ['1530', 'OFICINA DE GESTIÓN DOCUMENTAL', 'Oficina', '1500', 'Asesoría'],
    ];
    const MONICA_CENTERS = ['1010', '1110', '1210', '1220', '1310', '1410', '1510', '1520', '1530'];
    const monicaInput = (): OrgChartInput =>
      only({
        units: MONICA_ROWS.map(([prefix, name, type, parent, relation], index) =>
          unitRow(index + 2, { prefix, name, type, parent: parent || null, relation }),
        ),
        centers: MONICA_CENTERS.map((code, index) => centerRow(index + 2, { code, name: `CENTRO ${code}` })),
      });
    const empty = (): OrgChartSnapshot => ({ units: [], centers: [], removal: new Map() });

    it('el archivo de 18 filas pasa sin errores ni ciclos: prefijos cortos y jefes por el código de Contabilidad', () => {
      const plan = planOrgChart(empty(), monicaInput());
      expect(plan.errors).toEqual([]);
      const byKey = new Map(plan.units.map((op) => [op.key, op]));
      const prefixOf = (key: string | null) => (key ? (byKey.get(key)?.codePrefix ?? '?') : null);
      expect(plan.units.map((op) => [op.codePrefix, prefixOf(op.parentKey)])).toEqual([
        ['1', null],
        ['2', '1'],
        ['4', '1'],
        ['5', '1'],
        ['9', '1'],
        ['11', '1'],
        ['111', '11'],
        ['12', '1'],
        ['121', '12'],
        ['122', '12'],
        ['13', '1'],
        ['131', '13'],
        ['14', '1'],
        ['141', '14'],
        ['15', '1'],
        ['151', '15'],
        ['152', '15'],
        ['153', '15'],
      ]);
      const messages = plan.warnings.map((issue) => `${issue.rowNumber}: ${issue.message}`);
      expect(messages).toContain('7: 1100 se tomó como prefijo 11');
      expect(messages).toContain('10: 1210 se tomó como prefijo 121');
      expect(messages).toContain(
        '2: Hay 2 cuadros de tipo Rectoría (1 RECTORÍA; 11 Rectoría): las filas nuevas de un número sin «Depende de» quedan en la raíz',
      );
      expect(messages.some((message) => message.includes('ciclo'))).toBe(false);
      // Los centros quedan en la unidad de prefijo más largo.
      expect(Object.fromEntries(plan.centers.map((op) => [op.code, prefixOf(op.unitKey)]))).toEqual({
        '1010': '1',
        '1110': '111',
        '1210': '121',
        '1220': '122',
        '1310': '131',
        '1410': '141',
        '1510': '151',
        '1520': '152',
        '1530': '153',
      });
    });

    it('el prefijo 1000 o 1 sin código interno encuentra la Rectoría existente con prefijo 1', () => {
      const snapshot: OrgChartSnapshot = {
        units: [unit('u1', 'U1', 'RECTORÍA', '1', null, OrgUnitType.Rectorate)],
        centers: [],
        removal: new Map(),
      };
      for (const prefix of ['1', '1000']) {
        const plan = planOrgChart(snapshot, only({ units: [unitRow(2, { prefix, name: 'RECTORÍA', type: 'Rectoría' })] }));
        expect(plan.errors).toEqual([]);
        expect(plan.changes).toEqual([]);
      }
    });

    /** Vicerrectoría Financiera «4» con Centro propio 4010 y sus centros 4110…4165 (de 5 en 5). */
    const FINANCE_CODES = ['4110', '4115', '4120', '4125', '4130', '4135', '4140', '4145', '4150', '4155', '4160', '4165'];
    const financeSnapshot = (): OrgChartSnapshot => ({
      units: [
        unit('u1', 'U1', 'RECTORÍA', '1', null, OrgUnitType.Rectorate),
        { ...unit('u4', 'U4', 'VICERRECTORÍA FINANCIERA', '4', 'u1', OrgUnitType.Vicerectorate), headCostCenterId: 'c4010' },
        unit('u5', 'U5', 'VICERRECTORÍA BIENESTAR', '5', 'u1', OrgUnitType.Vicerectorate),
      ],
      centers: [center('c4010', '4010', 'u4', null), ...FINANCE_CODES.map((code) => center(`c${code}`, code, 'u4', null))],
      removal: new Map(),
    });
    const financeRows = (): UnitRowInput[] =>
      FINANCE_CODES.map((code, index) =>
        unitRow(index + 2, {
          prefix: code,
          name: ['DEPARTAMENTO DE SERVICIOS', 'DEPARTAMENTO DE LOGÍSTICA'][index] ?? `CENTRO ${code}`,
          type: 'Departamento',
          parent: '4010',
        }),
      );

    it('Depende de 4010 (el Centro propio de la Vicerrectoría Financiera): todo queda bajo 4', () => {
      const plan = planOrgChart(financeSnapshot(), only({ units: financeRows() }));
      expect(plan.errors).toEqual([]);
      expect(plan.units.map((op) => [op.codePrefix, op.parentKey])).toEqual(
        ['411', '4115', '412', '4125', '413', '4135', '414', '4145', '415', '4155', '416', '4165'].map((prefix) => [prefix, 'u4']),
      );
      expect(plan.warnings.map((issue) => issue.message)).toContain('Depende de 4010: el Centro propio de VICERRECTORÍA FINANCIERA (4)');
    });

    it('Depende de con un centro que no es Centro propio de nadie: lo dice y sugiere el prefijo', () => {
      const plan = planOrgChart(
        financeSnapshot(),
        only({ units: [unitRow(2, { prefix: '4170', name: 'ALMACÉN', type: 'Oficina', parent: '4110' })] }),
      );
      expect(plan.errors).toEqual([
        expect.objectContaining({
          column: 'Depende de',
          message: '4110 es un centro de costo pero ninguna unidad lo tiene como Centro propio; escriba el prefijo de la unidad, p. ej. 4',
        }),
      ]);
    });

    it('53 bajo 4 con la unidad 5: el mensaje nombra a la dueña, nunca al jefe ni a sus ancestros', () => {
      const plan = planOrgChart(
        financeSnapshot(),
        only({
          units: [
            unitRow(2, { prefix: '53', name: 'OFICINA X', type: 'Oficina', parent: '4' }),
            unitRow(3, { prefix: '1110', name: 'OFICINA JURÍDICA', type: 'Oficina', parent: '4' }),
          ],
        }),
      );
      expect(plan.errors.map((issue) => [issue.rowNumber, issue.message])).toEqual([
        [2, 'El prefijo 53 no empieza por el de su jefe (4) y los números 5… son de VICERRECTORÍA BIENESTAR'],
      ]);
      // 111 bajo 4: los números 1… son de la Rectoría, ancestro de 4; se acepta con advertencia, sin citarla.
      expect(plan.warnings.find((issue) => issue.rowNumber === 3 && issue.message.startsWith('El prefijo 111'))?.message).toBe(
        'El prefijo 111 no empieza por el de su jefe (4); se acepta porque ninguna otra unidad tiene sus dígitos iniciales',
      );
      // 111 bajo la Rectoría 1100 (11), que cuelga de la 1: la 1 es ancestro, no «otra unidad».
      const nested = planOrgChart(
        financeSnapshot(),
        only({
          units: [
            unitRow(2, { prefix: '1100', name: 'Rectoría', type: 'Rectoría', parent: '1' }),
            unitRow(3, { prefix: '1110', name: 'OFICINA JURÍDICA', type: 'Oficina', parent: '1100' }),
          ],
        }),
      );
      expect(nested.errors).toEqual([]);
    });
  });

  it('cada encabezado de las dos hojas tiene un comentario que lo explica', async () => {
    const [units, centers] = orgChartExportRows(baseSnapshot().units, baseSnapshot().centers);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await buildOrgChartWorkbook(units, centers, { example: false, generatedAt: new Date() })) as unknown as ArrayBuffer);
    const noteText = (note: ExcelJS.Cell['note']): string =>
      typeof note === 'string' ? note : (note?.texts ?? []).map((part) => part.text).join('');
    for (const name of ['Organigrama', 'Centros de costo']) {
      const header = workbook.getWorksheet(name)?.getRow(1);
      const cells: Array<[string, string]> = [];
      header?.eachCell((cell) => cells.push([String(cell.value), noteText(cell.note).trim()]));
      expect(cells).toHaveLength(9);
      for (const [title, note] of cells) {
        expect(note.length, `${name} · ${title}`).toBeGreaterThan(20);
      }
    }
  });
});
