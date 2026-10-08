import ExcelJS from 'exceljs';
import { OrgRelationType, OrgUnitType } from '../enums/org-unit-type.enum.js';
import { orgChartExportRows } from './org-chart-export.js';
import { IGNORED_CENTER_SHEET_WARNING, planOrgChart } from './org-chart-plan.js';
import { buildOrgChartWorkbook, parseOrgChartWorkbook } from './org-chart-workbook.js';
import {
  type CenterRowInput,
  type OrgChartInput,
  type OrgChartSnapshot,
  type SnapshotCenter,
  type SnapshotUnit,
  type UnitRowInput,
  unitsOnly,
} from './org-chart.types.js';

const unit = (id: string, code: string, name: string, prefix: string | null, parentId: string | null, type = OrgUnitType.Department): SnapshotUnit => ({
  id,
  code,
  name,
  unitType: type,
  parentId,
  relationType: OrgRelationType.Authority,
  headCostCenterId: null,
  headCostCenterCode: null,
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
  const units = orgChartExportRows(snapshot.units, snapshot.centers);
  return parseOrgChartWorkbook(await buildOrgChartWorkbook(units, { example: false, generatedAt: new Date() }));
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
  it('exportar y volver a subir sin cambios: 0 cambios, sin errores ni advertencias; solo unidades', async () => {
    const snapshot = baseSnapshot();
    const input = await roundTrip(snapshot);
    expect(input.units).toHaveLength(6);
    expect(input).toMatchObject({ centers: [], hasUnitSheet: true, hasCenterSheet: false, ignoredCenterSheet: false });
    const plan = planOrgChart(snapshot, input);
    expect(plan.errors).toEqual([]);
    expect(plan.changes).toEqual([]);
    expect(plan.warnings).toEqual([]);
  });

  it('la exportación ordena las unidades por árbol', () => {
    const units = orgChartExportRows(baseSnapshot().units, baseSnapshot().centers);
    expect(units.map((row) => [row.prefix, row.depth, row.parent])).toEqual([
      ['3', 0, null],
      ['30', 1, '3'],
      ['4', 0, null],
      ['41', 1, '4'],
      ['43', 1, '4'],
      [null, 0, null],
    ]);
  });

  describe('sin hoja de centros de costo', () => {
    const exported = (): Promise<Buffer> =>
      buildOrgChartWorkbook(orgChartExportRows(baseSnapshot().units, baseSnapshot().centers), {
        example: false,
        generatedAt: new Date(),
      });

    it('el libro trae solo Organigrama e Instrucciones, sin hablar de la hoja de centros ni de activos', async () => {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load((await exported()) as unknown as ArrayBuffer);
      expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['Organigrama', 'Instrucciones']);
      const lines: string[] = [];
      workbook.getWorksheet('Instrucciones')?.eachRow((row) => lines.push(String(row.getCell(1).value ?? '')));
      workbook.getWorksheet('Organigrama')?.getRow(1).eachCell((cell) => {
        const note = cell.note;
        lines.push(typeof note === 'string' ? note : (note?.texts ?? []).map((part) => part.text).join(''));
      });
      const text = lines.join('\n');
      // «centros de costo activos» (estado) sí; activos como bienes, no.
      expect(text.replace(/centros de costo activos?/gi, '').replace(/centro activo/gi, '')).not.toMatch(/activos/i);
      expect(text).not.toMatch(/hoja «?Centros de costo/i);
      expect(text).not.toContain('Código anterior');
    });

    it('un archivo viejo con la hoja «Centros de costo» la ignora con una advertencia y no toca centros', async () => {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load((await exported()) as unknown as ArrayBuffer);
      const old = workbook.addWorksheet('Centros de costo');
      old.addRow(['Código', 'Nombre', 'Movimiento', 'Unidad', 'Padre', 'Activos', 'Estado', 'Acción', 'Código anterior']);
      old.addRow(['4351', 'RENOMBRADO', 1, null, null, 0, 'Activo', null, null]);
      old.addRow(['4352', 'CENTRO 4352', 1, null, null, 0, 'Activo', 'ELIMINAR', null]);
      old.addRow(['4999', 'NUEVO', 1, null, null, null, null, null, null]);
      const input = await parseOrgChartWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()));
      expect(input).toMatchObject({ centers: [], hasCenterSheet: false, ignoredCenterSheet: true });
      const plan = planOrgChart(baseSnapshot(), input);
      expect(plan.errors).toEqual([]);
      expect(plan.changes).toEqual([]);
      expect(plan.centers).toEqual([]);
      expect(plan.warnings).toEqual([{ sheet: 'Centros de costo', rowNumber: 1, column: null, message: IGNORED_CENTER_SHEET_WARNING }]);
      expect(IGNORED_CENTER_SHEET_WARNING).toBe('La hoja Centros de costo se ignoró: los centros se administran en su propia pantalla');
    });

    it('una previsualización guardada con filas de centros las descarta al planear (unitsOnly)', () => {
      const stored = only({
        units: [unitRow(2, { prefix: '43', name: 'Departamento de Servicios Administrativos', code: 'U43' })],
        centers: [centerRow(2, { code: '4351', name: 'TESORERÍA AUXILIAR' }), centerRow(3, { code: '4352', name: 'X', action: 'ELIMINAR' })],
      });
      const plan = planOrgChart(baseSnapshot(), unitsOnly(stored));
      expect(plan.centers).toEqual([]);
      expect(plan.changes).toEqual([]);
      expect(plan.warnings.map((issue) => issue.message)).toEqual([IGNORED_CENTER_SHEET_WARNING]);
    });

    it('un archivo sin la hoja Organigrama no es un Excel del organigrama (aunque traiga la de centros)', async () => {
      const workbook = new ExcelJS.Workbook();
      workbook.addWorksheet('Centros de costo').addRow(['Código', 'Nombre']);
      await expect(parseOrgChartWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()))).rejects.toMatchObject({
        code: 'ORG_CHART_INVALID_FILE',
      });
    });

    it('Centro propio por código: uno que no existe queda pendiente con advertencia; uno existente se amarra', () => {
      const plan = planOrgChart(
        baseSnapshot(),
        only({
          units: [
            unitRow(2, { prefix: '45', name: 'Departamento de Contabilidad', type: 'Departamento', parent: '4', headCenter: '4510' }),
            unitRow(3, { prefix: '43', name: 'Departamento de Servicios Administrativos', code: 'U43', headCenter: '4350' }),
          ],
        }),
      );
      expect(plan.errors).toEqual([]);
      expect(plan.warnings).toContainEqual(
        expect.objectContaining({
          rowNumber: 2,
          column: 'Centro propio',
          message: 'Centro propio 4510 pendiente: el centro aún no existe; se amarrará solo cuando se cree',
        }),
      );
      expect(plan.units.find((op) => op.code !== 'U43' && op.codePrefix === '45')).toMatchObject({
        headCenterKey: null,
        headCenterCode: '4510',
      });
      expect(plan.units.find((op) => op.key === 'u43')).toMatchObject({
        headCenterKey: 'c4350',
        headCenterCode: '4350',
        kinds: ['HEAD_CHANGED'],
      });
    });
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

  /** Lógica de centros del plan: el Excel del organigrama no la usa (unitsOnly); se conserva para el de centros. */
  describe('lógica de centros del plan (sin uso en el Excel del organigrama)', () => {
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
  });

  it('filas que no están en el archivo no se tocan', () => {
    const plan = planOrgChart(baseSnapshot(), only({ units: [unitRow(2, { prefix: '41', name: 'Departamento Financiero', code: 'U41' })] }));
    expect(plan.errors).toEqual([]);
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
          item.id === 'u43' ? { ...item, headCostCenterId: 'c4350', headCostCenterCode: '4350', relationType: OrgRelationType.Coordination } : item,
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
        {
          ...snapshot,
          units: [...snapshot.units, unit('u1', 'U1', 'Rectoría', '1', null, OrgUnitType.Rectorate)],
          centers: [...snapshot.centers, center('c5010', '5010', null, null)],
        },
        only({ units: [unitRow(2, { prefix: '5', name: 'Vicerrectoría de Bienestar', type: 'Vicerrectoría' })] }),
      );
      expect(plan.errors).toEqual([]);
      expect(plan.centers).toEqual([]);
      expect(plan.units[0]).toMatchObject({ code: 'U5', parentKey: 'u1', headCenterKey: 'c5010' });
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
      });
    /** Sin unidades; los centros ya existen en el sistema (se administran en su pantalla). */
    const empty = (): OrgChartSnapshot => ({
      units: [],
      centers: MONICA_CENTERS.map((code) => center(`c${code}`, code, null, null)),
      removal: new Map(),
    });

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
      // Centro propio deducido del Prefijo de 4 dígitos que es un centro del sistema (y 1 → 1010).
      expect(plan.centers).toEqual([]);
      expect(plan.units.map((op) => (op.headCenterKey ? op.headCenterKey.slice(1) : null))).toEqual([
        '1010', null, null, null, null, null, '1110', null, '1210', '1220', null, '1310', null, '1410', null, '1510', '1520', '1530',
      ]);
      expect(messages).toContain('17: Centro propio deducido: 1510');
      expect(messages).toContain('13: 1310 tiene el mismo nombre que su jefe 1300; ¿es su Centro propio?');
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
        { ...unit('u4', 'U4', 'VICERRECTORÍA FINANCIERA', '4', 'u1', OrgUnitType.Vicerectorate), headCostCenterId: 'c4010', headCostCenterCode: '4010' },
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
      expect(plan.units.map((op) => op.headCenterKey)).toEqual(FINANCE_CODES.map((code) => `c${code}`));
    });

    it('después de importar, exportar y volver a subir no cambia nada (prefijos de 3 y 4 dígitos)', async () => {
      const snapshot = financeSnapshot();
      const imported: OrgChartSnapshot = {
        ...snapshot,
        units: [
          ...snapshot.units,
          { ...unit('u411', 'U411', 'DEPARTAMENTO DE SERVICIOS', '411', 'u4'), headCostCenterId: 'c4110', headCostCenterCode: '4110' },
          unit('u4115', 'U4115', 'DEPARTAMENTO DE LOGÍSTICA', '4115', 'u4'),
        ],
        centers: snapshot.centers.map((item) =>
          item.id === 'c4110' ? { ...item, unitId: 'u411' } : item.id === 'c4115' ? { ...item, unitId: 'u4115' } : item,
        ),
      };
      const plan = planOrgChart(imported, await roundTrip(imported));
      expect(plan.errors).toEqual([]);
      expect(plan.changes).toEqual([]);
    });

    it('prefijo repetido en el archivo (tras normalizar): error claro', () => {
      const plan = planOrgChart(
        financeSnapshot(),
        only({
          units: [
            unitRow(2, { prefix: '4200', name: 'DEPARTAMENTO DE PLANEACIÓN FINANCIERA', type: 'Departamento', parent: '4' }),
            unitRow(3, { prefix: '42', name: 'OFICINA DE PRESUPUESTO', type: 'Oficina', parent: '4' }),
          ],
        }),
      );
      expect(plan.errors).toEqual([
        expect.objectContaining({
          rowNumber: 3,
          column: 'Prefijo',
          message:
            'El prefijo 42 ya lo usa la fila 2 (DEPARTAMENTO DE PLANEACIÓN FINANCIERA): cada cuadro necesita uno distinto; si es una oficina de ese cuadro, deje el prefijo vacío o use más dígitos (421)',
        }),
      ]);
    });

    it('Prefijo vacío en una unidad existente lo conserva; NINGUNO lo quita', () => {
      const keep = planOrgChart(
        financeSnapshot(),
        only({ units: [unitRow(2, { name: 'VICERRECTORÍA BIENESTAR', code: 'U5' })] }),
      );
      expect(keep.errors).toEqual([]);
      expect(keep.changes).toEqual([]);
      const remove = planOrgChart(
        financeSnapshot(),
        only({ units: [unitRow(2, { prefix: 'NINGUNO', name: 'VICERRECTORÍA BIENESTAR', code: 'U5' })] }),
      );
      expect(remove.errors).toEqual([]);
      expect(remove.units[0]).toMatchObject({ key: 'u5', codePrefix: null, kinds: ['PREFIX_CHANGED'] });
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

  it('cada encabezado de la hoja Organigrama tiene un comentario que lo explica', async () => {
    const units = orgChartExportRows(baseSnapshot().units, baseSnapshot().centers);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await buildOrgChartWorkbook(units, { example: false, generatedAt: new Date() })) as unknown as ArrayBuffer);
    const noteText = (note: ExcelJS.Cell['note']): string =>
      typeof note === 'string' ? note : (note?.texts ?? []).map((part) => part.text).join('');
    for (const name of ['Organigrama']) {
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
