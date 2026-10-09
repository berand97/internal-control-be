import ExcelJS from 'exceljs';
import type { OrgHistoryField } from '../../cost-centers/services/org-structure-history.service.js';
import { OrgRelationType, OrgUnitType } from '../enums/org-unit-type.enum.js';
import { orgChartExportRows } from './org-chart-export.js';
import { type ChangeInfo, type DeletedUnitInfo, type MergeContext, mergeOrgChartInput } from './org-chart-merge.js';
import { planOrgChart } from './org-chart-plan.js';
import { structureRevision } from './org-chart-stamp.js';
import { buildOrgChartWorkbook, parseOrgChartWorkbook } from './org-chart-workbook.js';
import type { OrgChartInput, SnapshotCenter, SnapshotUnit, UnitRowInput } from './org-chart.types.js';

const unit = (
  id: string,
  code: string,
  name: string,
  prefix: string | null,
  parentId: string | null,
  type = OrgUnitType.Department,
): SnapshotUnit => ({
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
  color: null,
});

const center = (id: string, code: string, unitId: string): SnapshotCenter => ({
  id,
  externalCode: code,
  name: `CENTRO ${code}`,
  hasMovement: true,
  isActive: true,
  unitId,
  parentId: null,
  activeAssets: 0,
});

const baseUnits = (): SnapshotUnit[] => [
  { ...unit('u4', 'U4', 'Vicerrectoría Financiera', '4', null, OrgUnitType.Vicerectorate), headCostCenterId: 'c4010', headCostCenterCode: '4010' },
  unit('u41', 'U41', 'Contabilidad', '41', 'u4'),
  unit('u43', 'U43', 'Servicios Administrativos', '43', 'u4'),
  unit('u3', 'U3', 'Vicerrectoría Académica', '3', null, OrgUnitType.Vicerectorate),
  unit('u30', 'U30', 'Servicios Educativos', '30', 'u3'),
];
const centers: SnapshotCenter[] = [center('c4010', '4010', 'u4'), center('c4110', '4110', 'u41')];

const DOWNLOADED_AT = new Date('2026-10-08T13:00:00.000Z');
const AFTER = '2026-10-08T15:30:00.000Z';
const BEFORE = '2026-10-01T10:00:00.000Z';

/** Descarga: el Excel exportado con su sello, leído como lo leería la previsualización. */
const download = async (units: ReadonlyArray<SnapshotUnit>, at = DOWNLOADED_AT): Promise<OrgChartInput> =>
  parseOrgChartWorkbook(
    await buildOrgChartWorkbook(orgChartExportRows(units, centers), {
      kind: 'EXPORT',
      generatedAt: at,
      revision: structureRevision(units),
    }),
  );

/**
 * Descarga de antes de la columna Color: se le quita la columna a la hoja Organigrama y la huella del Color al sello
 * (última columna de la hoja «_sello»), como eran los archivos viejos.
 */
const downloadWithoutColor = async (units: ReadonlyArray<SnapshotUnit>): Promise<OrgChartInput> => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(
    (await buildOrgChartWorkbook(orgChartExportRows(units, centers), {
      kind: 'EXPORT',
      generatedAt: DOWNLOADED_AT,
      revision: structureRevision(units),
    })) as unknown as ArrayBuffer,
  );
  const sheet = workbook.getWorksheet('Organigrama');
  const header = sheet?.getRow(1);
  let colorColumn = 0;
  header?.eachCell((cell, column) => {
    if (cell.value === 'Color') {
      colorColumn = column;
    }
  });
  sheet?.spliceColumns(colorColumn, 1);
  const stampSheet = workbook.getWorksheet('_sello');
  stampSheet?.getColumn(9).eachCell((cell) => {
    cell.value = null;
  });
  return parseOrgChartWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()));
};

const edit = (input: OrgChartInput, code: string, values: Partial<UnitRowInput>): OrgChartInput => ({
  ...input,
  units: input.units.map((row) => (row.code === code ? { ...row, ...values } : row)),
});

const withUnit = (units: SnapshotUnit[], id: string, values: Partial<SnapshotUnit>): SnapshotUnit[] =>
  units.map((item) => (item.id === id ? { ...item, ...values } : item));

const changes = (
  entries: ReadonlyArray<[string, OrgHistoryField, ChangeInfo]>,
): Map<string, Map<OrgHistoryField, ChangeInfo>> => {
  const map = new Map<string, Map<OrgHistoryField, ChangeInfo>>();
  for (const [unitId, field, info] of entries) {
    map.set(unitId, (map.get(unitId) ?? new Map()).set(field, info));
  }
  return map;
};

const run = (units: SnapshotUnit[], input: OrgChartInput, context: Partial<MergeContext> = {}) => {
  const merge = mergeOrgChartInput(input, {
    units,
    centers,
    lastChanges: new Map(),
    deletedUnits: new Map<string, DeletedUnitInfo>(),
    unitOrigins: new Map(),
    now: new Date(DOWNLOADED_AT.getTime() + 60_000),
    ...context,
  });
  const plan = planOrgChart({ units, centers, removal: new Map() }, merge.input);
  return { merge, plan, errors: [...merge.errors, ...plan.errors], warnings: [...merge.warnings, ...plan.warnings] };
};

describe('Excel del organigrama a prueba de archivos viejos (sello y merge de tres vías)', () => {
  it('descargar y subir sin tocar en el mismo minuto: 0 cambios, sin advertencias; el sello trae fecha de creación', async () => {
    const units = baseUnits();
    const input = await download(units);
    expect(input.stamp?.rows).toHaveLength(5);
    expect(input.stamp?.exportedAt).toBe(DOWNLOADED_AT.toISOString());
    expect(input.fileCreatedAt).toBe(DOWNLOADED_AT.toISOString());
    const { merge, plan, errors, warnings } = run(units, input);
    expect(merge.input.units).toEqual([]);
    expect(plan.changes).toEqual([]);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(merge.fileAgeDays).toBe(0);
  });

  it('archivo viejo sin tocar: no revierte renombres, movimientos ni prefijos hechos después por otros', async () => {
    const input = await download(baseUnits());
    let now = withUnit(baseUnits(), 'u41', { name: 'Contabilidad General' });
    now = withUnit(now, 'u43', { parentId: 'u3' });
    now = withUnit(now, 'u30', { codePrefix: '31', code: 'U30' });
    const { plan, errors, merge } = run(now, input);
    expect(plan.changes).toEqual([]);
    expect(errors).toEqual([]);
    expect(merge.conflicts).toEqual([]);
  });

  it('fila tocada sin conflicto: se aplica solo lo que cambió la persona', async () => {
    const input = edit(await download(baseUnits()), 'U30', { name: 'Servicios Educativos y Bibliotecas' });
    const now = withUnit(baseUnits(), 'u41', { name: 'Contabilidad General' });
    const { plan, errors } = run(now, input);
    expect(errors).toEqual([]);
    expect(plan.changes.map((change) => [change.name, change.kind])).toEqual([['Servicios Educativos y Bibliotecas', 'RENAMED']]);
  });

  it('dos personas con archivos del mismo día cambian la misma columna: conflicto para la segunda, con quién y cuándo', async () => {
    const units = baseUnits();
    const first = edit(await download(units), 'U41', { name: 'Contabilidad A' });
    const second = edit(await download(units), 'U41', { name: 'Contabilidad B' });
    expect(run(units, first).plan.changes.map((change) => change.kind)).toEqual(['RENAMED']);
    // La primera se aplicó.
    const now = withUnit(units, 'u41', { name: 'Contabilidad A' });
    const lastChanges = changes([['u41', 'NAME', { at: AFTER, byName: 'Ana Pérez' }]]);
    const { merge, plan, errors } = run(now, second, { lastChanges });
    expect(merge.conflicts).toEqual([
      {
        rowNumber: expect.any(Number),
        unitName: 'Contabilidad A',
        column: 'Nombre',
        fileValue: 'Contabilidad B',
        currentValue: 'Contabilidad A',
        changedAt: AFTER,
        changedBy: 'Ana Pérez',
      },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('otra persona lo cambió el 08/10/2026');
    expect(errors[0]?.message).toContain('Ana Pérez');
    expect(errors[0]?.message).toContain('«Contabilidad A»');
    expect(errors[0]?.message).toContain('Descargue el organigrama de nuevo');
    expect(plan.changes).toEqual([]);
  });

  it('columnas distintas de la misma unidad: se aplican las dos (la del otro se conserva)', async () => {
    const units = baseUnits();
    const input = edit(await download(units), 'U41', { relation: 'Asesoría' });
    const now = withUnit(units, 'u41', { name: 'Contabilidad General' });
    const { plan, errors, merge } = run(now, input, {
      lastChanges: changes([['u41', 'NAME', { at: AFTER, byName: 'Ana Pérez' }]]),
    });
    expect(errors).toEqual([]);
    expect(merge.conflicts).toEqual([]);
    expect(plan.units).toHaveLength(1);
    expect(plan.units[0]).toMatchObject({ name: 'Contabilidad General', relationType: OrgRelationType.Advisory, kinds: ['RELATION_CHANGED'] });
  });

  it('aplicar y volver a subir el mismo archivo: 0 cambios y sin conflicto aunque la base cambió después del sello', async () => {
    const units = baseUnits();
    const input = edit(await download(units), 'U41', { name: 'Contabilidad A', prefix: '42' });
    expect(run(units, input).plan.changes).toHaveLength(1);
    const now = withUnit(units, 'u41', { name: 'Contabilidad A', codePrefix: '42' });
    const lastChanges = changes([
      ['u41', 'NAME', { at: AFTER, byName: 'Ana Pérez' }],
      ['u41', 'PREFIX', { at: AFTER, byName: 'Ana Pérez' }],
    ]);
    const { plan, errors, merge } = run(now, input, { lastChanges });
    expect(merge.conflicts).toEqual([]);
    expect(errors).toEqual([]);
    expect(plan.changes).toEqual([]);
  });

  it('Código interno de una unidad eliminada: advertencia con fecha y no se vuelve a crear', async () => {
    const input = edit(await download(baseUnits()), 'U43', { name: 'Servicios Administrativos (cambio)' });
    const now = baseUnits().filter((item) => item.id !== 'u43');
    const deletedUnits = new Map<string, DeletedUnitInfo>([
      ['U43', { at: AFTER, byName: 'Ana Pérez', name: 'Servicios Administrativos' }],
    ]);
    const { plan, errors, warnings } = run(now, input, { deletedUnits });
    expect(errors).toEqual([]);
    expect(plan.changes).toEqual([]);
    expect(warnings.map((warning) => warning.message)).toContainEqual(
      expect.stringMatching(/«Servicios Administrativos» se eliminó el 08\/10\/2026.*Ana Pérez: no se vuelve a crear\. Para crearla de nuevo borre su Código interno/),
    );
    // Sin rastro de la eliminación también se niega (antes se creaba con ese código).
    const unknown = run(now, input);
    expect(unknown.plan.changes).toEqual([]);
    expect(unknown.warnings.map((warning) => warning.message)).toContainEqual(expect.stringContaining('No hay ninguna unidad con Código interno U43'));
  });

  it('archivada después de la descarga: el archivo sin tocar no la reactiva; si la persona cambió Estado, sí', async () => {
    const input = await download(baseUnits());
    const now = withUnit(baseUnits(), 'u30', { isActive: false });
    expect(run(now, input).plan.changes).toEqual([]);
    const reactivate = edit(await download(now), 'U30', { status: 'Activo' });
    expect(run(now, reactivate).plan.changes.map((change) => change.kind)).toEqual(['REACTIVATED']);
  });

  it('sin sello: Activo reactiva solo si se archivó ANTES de la fecha del archivo; sin fecha, no', async () => {
    const stampless = (fileCreatedAt: string | null): OrgChartInput => ({
      units: [
        {
          rowNumber: 2,
          prefix: '30',
          name: 'Servicios Educativos',
          type: 'Departamento',
          parent: '3',
          relation: 'Autoridad',
          headCenter: null,
          status: 'Activo',
          action: null,
          code: 'U30',
        },
      ],
      centers: [],
      hasUnitSheet: true,
      hasCenterSheet: false,
      stamp: null,
      fileCreatedAt,
    });
    const now = withUnit(baseUnits(), 'u30', { isActive: false });
    const after = changes([['u30', 'STATUS', { at: AFTER, byName: 'Ana Pérez' }]]);
    const late = run(now, stampless(DOWNLOADED_AT.toISOString()), { lastChanges: after });
    expect(late.plan.changes).toEqual([]);
    expect(late.warnings.map((warning) => warning.message)).toContainEqual(expect.stringContaining('después de que se hizo este archivo: no se reactiva'));
    expect(late.warnings.map((warning) => warning.message)).toContainEqual(expect.stringContaining('no trae el sello de la descarga'));

    const before = changes([['u30', 'STATUS', { at: BEFORE, byName: 'Ana Pérez' }]]);
    expect(run(now, stampless(DOWNLOADED_AT.toISOString()), { lastChanges: before }).plan.changes.map((change) => change.kind)).toEqual(['REACTIVATED']);

    const undated = run(now, stampless(null), { lastChanges: before });
    expect(undated.plan.changes).toEqual([]);
    expect(undated.warnings.map((warning) => warning.message)).toContainEqual(expect.stringContaining('no dice cuándo se hizo'));
  });

  it('fila nueva sin Código interno ni prefijo subida dos veces: la segunda vez se toma como la existente (sin duplicado)', () => {
    const input: OrgChartInput = {
      units: [
        { rowNumber: 2, prefix: null, name: 'Oficina de Calidad', type: 'Oficina', parent: '4', relation: null, headCenter: null, status: null, action: null, code: null },
      ],
      centers: [],
      hasUnitSheet: true,
      hasCenterSheet: false,
    };
    expect(run(baseUnits(), input).plan.changes.map((change) => change.kind)).toEqual(['CREATED']);
    const now = [...baseUnits(), { ...unit('uq', 'OFICINA_DE_CALIDAD', 'Oficina de Calidad', null, 'u4'), unitType: OrgUnitType.Office }];
    const unitOrigins = new Map<string, ChangeInfo>([['uq', { at: AFTER, byName: 'Ana Pérez' }]]);
    const { plan, errors, warnings } = run(now, input, { unitOrigins });
    expect(errors).toEqual([]);
    expect(plan.changes).toEqual([]);
    expect(warnings.map((warning) => warning.message)).toContainEqual(
      expect.stringMatching(/«Oficina de Calidad» ya existe bajo el mismo jefe \(creada el 08\/10\/2026 por Ana Pérez\)/),
    );
    // Mismo nombre sin tildes ni mayúsculas, bajo otro jefe: es otra unidad.
    const elsewhere = run(now, { ...input, units: [{ ...input.units[0]!, name: 'OFICINA DE CALIDAD', parent: '3' }] });
    expect(elsewhere.plan.changes.map((change) => change.kind)).toEqual(['CREATED']);
  });

  it('fila nueva con el prefijo de una unidad activa: se toma como ella y se advierte que ya existe', () => {
    const input: OrgChartInput = {
      units: [
        { rowNumber: 2, prefix: '43', name: 'Servicios Administrativos', type: 'Departamento', parent: null, relation: null, headCenter: null, status: null, action: null, code: null },
      ],
      centers: [],
      hasUnitSheet: true,
      hasCenterSheet: false,
    };
    const { plan, warnings } = run(baseUnits(), input);
    expect(plan.changes).toEqual([]);
    expect(warnings.map((warning) => warning.message)).toContainEqual('El prefijo 43 ya existe: «Servicios Administrativos». La fila se toma como esa unidad');
  });

  it('plantilla: hoja Organigrama vacía (el ejemplo en Instrucciones); subida tal cual o con la fila de ejemplo vieja = 0 cambios', async () => {
    const template = await parseOrgChartWorkbook(
      await buildOrgChartWorkbook([], { kind: 'TEMPLATE', generatedAt: DOWNLOADED_AT, revision: 'TEMPLATE' }),
    );
    expect(template.units).toEqual([]);
    expect(template.stamp?.kind).toBe('TEMPLATE');
    const now = withUnit(baseUnits(), 'u4', { name: 'Vicerrectoría Administrativa y Financiera', headCostCenterId: null, headCostCenterCode: null });
    expect(run(now, template).plan.changes).toEqual([]);
    const oldTemplate: OrgChartInput = {
      units: [
        { rowNumber: 2, prefix: '4', name: 'Vicerrectoría Financiera', type: 'Vicerrectoría', parent: null, relation: 'Autoridad', headCenter: '4010', status: 'Activo', action: null, code: null },
      ],
      centers: [],
      hasUnitSheet: true,
      hasCenterSheet: false,
    };
    const { plan, warnings } = run(now, oldTemplate);
    expect(plan.changes).toEqual([]);
    expect(warnings.map((warning) => warning.message)).toContain('Es la fila de ejemplo de la plantilla: se ignora');
  });

  it('archivo descargado hace más de 7 días: advertencia con los días', async () => {
    const input = await download(baseUnits(), new Date('2026-09-20T13:00:00.000Z'));
    const { merge, warnings } = run(baseUnits(), input, { now: new Date('2026-10-08T13:00:00.000Z') });
    expect(merge.fileAgeDays).toBe(18);
    expect(warnings.map((warning) => warning.message)).toContainEqual(expect.stringContaining('Este archivo se descargó hace 18 días'));
  });

  describe('columna Color', () => {
    const coloredUnits = (): SnapshotUnit[] => withUnit(baseUnits(), 'u4', { color: '#de9927' });

    it('dos personas cambian el Color de la misma unidad: conflicto en la columna Color', async () => {
      const units = coloredUnits();
      const second = edit(await download(units), 'U4', { color: '#111111' });
      const now = withUnit(units, 'u4', { color: '#29b1b2' });
      const lastChanges = changes([['u4', 'COLOR', { at: AFTER, byName: 'Ana Pérez' }]]);
      const { merge, plan, errors } = run(now, second, { lastChanges });
      expect(merge.conflicts).toEqual([
        {
          rowNumber: expect.any(Number),
          unitName: 'Vicerrectoría Financiera',
          column: 'Color',
          fileValue: '#111111',
          currentValue: '#29b1b2',
          changedAt: AFTER,
          changedBy: 'Ana Pérez',
        },
      ]);
      expect(errors[0]?.column).toBe('Color');
      expect(plan.changes).toEqual([]);
    });

    it('Color cambiado por la persona sin cambio ajeno: se aplica; si otro cambió el color, el archivo sin tocar lo conserva', async () => {
      const units = coloredUnits();
      const input = edit(await download(units), 'U4', { color: '#29B1B2' });
      expect(run(units, input).plan.changes.map((change) => change.detail)).toEqual(['Color: #de9927 → #29b1b2']);
      const untouched = await download(units);
      const now = withUnit(units, 'u4', { color: '#123456' });
      const { plan, merge } = run(now, untouched);
      expect(plan.changes).toEqual([]);
      expect(merge.conflicts).toEqual([]);
    });

    it('Color vaciado en el archivo: no cambia ni choca aunque otro haya cambiado el color', async () => {
      const units = coloredUnits();
      const input = edit(await download(units), 'U4', { color: null });
      const now = withUnit(units, 'u4', { color: '#29b1b2' });
      const { plan, merge, errors } = run(now, input);
      expect(errors).toEqual([]);
      expect(merge.conflicts).toEqual([]);
      expect(plan.changes).toEqual([]);
    });

    it('archivo viejo sin la columna Color: el sello sigue valiendo, nada cambia de color ni hay conflicto', async () => {
      const units = coloredUnits();
      const input = await downloadWithoutColor(units);
      expect(input.invalidStamp).toBe(false);
      expect(input.stamp?.rows[0]?.columns.color).toBe('');
      expect(input.units.every((row) => row.color === null)).toBe(true);
      const now = withUnit(units, 'u41', { color: '#29b1b2' });
      const renamed = edit(input, 'U4', { name: 'Vicerrectoría Administrativa y Financiera' });
      const { plan, merge, errors } = run(now, renamed);
      expect(errors).toEqual([]);
      expect(merge.conflicts).toEqual([]);
      expect(plan.changes.map((change) => change.kind)).toEqual(['RENAMED']);
      expect(plan.units[0]?.color).toBe('#de9927');
      // Previsualización guardada antes de la columna: filas sin la propiedad color.
      const stored: OrgChartInput = {
        ...renamed,
        units: renamed.units.map(({ color: _color, ...row }) => row),
      };
      expect(run(now, stored).plan.changes.map((change) => change.kind)).toEqual(['RENAMED']);
    });

    it('sello viejo (sin huella de Color) con un Color escrito a mano: se aplica si difiere del sistema', async () => {
      const units = coloredUnits();
      const input = edit(await downloadWithoutColor(units), 'U41', { color: '#29b1b2' });
      const { plan, errors } = run(units, input);
      expect(errors).toEqual([]);
      expect(plan.changes.map((change) => [change.name, change.detail])).toEqual([['Contabilidad', 'Color: (sin color) → #29b1b2']]);
    });
  });

  it('una acción ELIMINAR en una fila sin otros cambios sí se planea', async () => {
    const input = edit(await download(baseUnits()), 'U43', { action: 'ELIMINAR' });
    expect(run(baseUnits(), input).plan.changes.map((change) => change.kind)).toEqual(['DELETED']);
  });
});
