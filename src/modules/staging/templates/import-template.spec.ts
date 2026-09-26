import ExcelJS from 'exceljs';
import { readWorkbook } from '../excel/read-workbook.js';
import { catalogCode, IMPORT_TARGETS, type ImportTarget, recognizeColumns, templateFields } from '../import/import-fields.js';
import {
  buildTemplate,
  CATALOG_SHEET,
  catalogsUsedBy,
  contentHash,
  DATA_SHEET_NAME,
  definitionHash,
  EXAMPLE_ROW,
  INSTRUCTIONS_SHEET,
  META_SHEET,
  readTemplateMarker,
  type TemplateCatalogs,
  templateVersion,
} from './import-template.js';

const CATALOGS: TemplateCatalogs = {
  COST_CENTERS: [
    { code: '4360', name: 'DEPARTAMENTO DE FINANZAS ESTUDIANTILES' },
    { code: '4630', name: 'OTRO CENTRO' },
  ],
  CATEGORIES: [{ code: 'SIN_CLASIFICAR', name: 'Sin clasificar' }],
  DOCUMENT_TYPES: [
    { code: 'CC', name: 'Cédula de ciudadanía' },
    { code: 'CE', name: 'Cédula de extranjería' },
  ],
  PHYSICAL_CONDITIONS: [
    { code: 'NEW', name: 'Nuevo' },
    { code: 'GOOD', name: 'Bueno' },
  ],
};

const open = async (body: Buffer): Promise<ExcelJS.Workbook> => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(body as unknown as ArrayBuffer);
  return workbook;
};

describe('plantillas de importación generadas desde la definición', () => {
  it.each(IMPORT_TARGETS)('%s: sin fórmulas, sin celdas combinadas, hojas y encabezados de la definición', async (target) => {
    const built = await buildTemplate({ target, catalogs: CATALOGS, generatedAt: new Date('2026-09-26T00:00:00Z') });
    const workbook = await open(built.body);
    expect(workbook.worksheets.map((sheet) => [sheet.name, sheet.state])).toEqual([
      [DATA_SHEET_NAME[target], 'visible'],
      [INSTRUCTIONS_SHEET, 'visible'],
      [CATALOG_SHEET, 'hidden'],
      [META_SHEET, 'hidden'],
    ]);
    for (const sheet of workbook.worksheets) {
      expect(Object.keys((sheet.model as { merges?: Record<string, unknown> }).merges ?? {})).toEqual([]);
      sheet.eachRow({ includeEmpty: false }, (row) =>
        row.eachCell({ includeEmpty: false }, (cell) => {
          expect(cell.type).not.toBe(ExcelJS.ValueType.Formula);
          expect(cell.isMerged).toBe(false);
        }),
      );
    }
    const data = workbook.getWorksheet(DATA_SHEET_NAME[target]);
    const fields = templateFields(target);
    const headers = fields.map((_, index) => data?.getRow(1).getCell(index + 1).value);
    expect(headers).toEqual(fields.map(([, field]) => field.header));
    // Solo encabezados y la fila de ejemplo: ningún bloque de resumen.
    expect(data?.actualRowCount).toBe(2);
    fields.forEach(([, field], index) => {
      const header = data?.getRow(1).getCell(index + 1);
      const fill = header?.fill as ExcelJS.FillPattern | undefined;
      expect(fill?.fgColor?.argb).toBe(field.whenEmpty.effect === 'QUARANTINE' ? 'FFC00000' : 'FFD9D9D9');
      if (field.kind === 'code' || field.kind === 'catalog') {
        expect(data?.getColumn(index + 1).numFmt).toBe('@');
      }
    });

    const sheets = await readWorkbook(built.body);
    const marker = readTemplateMarker(sheets.find((sheet) => sheet.name === META_SHEET)?.rows ?? []);
    expect(marker).toMatchObject({
      target,
      version: templateVersion(target),
      definitionHash: definitionHash(target),
      dataSheet: DATA_SHEET_NAME[target],
      headerRow: 1,
    });
    const exampleRow = sheets.find((sheet) => sheet.name === DATA_SHEET_NAME[target])?.rows.find((row) => row.rowNumber === EXAMPLE_ROW);
    expect(exampleRow?.cells).toEqual(marker?.example);
    const instructions = sheets.find((sheet) => sheet.name === INSTRUCTIONS_SHEET)?.rows ?? [];
    expect(instructions.some((row) => String(row.cells['A']).includes(`Versión de plantilla: ${built.version}`))).toBe(true);
    for (const [, field] of fields) {
      expect(instructions.some((row) => row.cells['A'] === field.header && row.cells['E'] === field.whenEmpty.text)).toBe(true);
    }
    expect(recognizeColumns(target, sheets[0]?.rows[0]?.cells as Record<string, string>)).toEqual(
      Object.fromEntries(fields.map(([name], index) => [name, String.fromCharCode(65 + index)])),
    );
  });

  it('los desplegables son listas contra la hoja oculta y muestran código y nombre', async () => {
    const built = await buildTemplate({ target: 'ASSETS', catalogs: CATALOGS, generatedAt: new Date() });
    const workbook = await open(built.body);
    const data = workbook.getWorksheet('Activos');
    const fields = templateFields('ASSETS');
    const letter = (name: string) => String.fromCharCode(65 + fields.findIndex(([field]) => field === name));
    const catalogs = catalogsUsedBy('ASSETS');
    expect(catalogs).toEqual(['COST_CENTERS', 'CATEGORIES', 'PHYSICAL_CONDITIONS']);
    const validation = data?.getCell(`${letter('costCenterCode')}3`).dataValidation;
    expect(validation).toMatchObject({ type: 'list', formulae: [`'${CATALOG_SHEET}'!$A$2:$A$3`] });
    expect(data?.getCell(`${letter('categoryCode')}500`).dataValidation).toMatchObject({ formulae: [`'${CATALOG_SHEET}'!$B$2:$B$2`] });
    expect(data?.getCell(`${letter('physicalCondition')}5001`).dataValidation).toMatchObject({ formulae: [`'${CATALOG_SHEET}'!$C$2:$C$3`] });
    const catalog = workbook.getWorksheet(CATALOG_SHEET);
    expect(catalog?.getCell('A2').value).toBe('4360 — DEPARTAMENTO DE FINANZAS ESTUDIANTILES');
    expect(catalog?.getCell('A3').value).toBe('4630 — OTRO CENTRO');
    expect(catalogCode(String(catalog?.getCell('A2').value))).toBe('4360');
  });

  it('versión = definición; los catálogos solo cambian el contenido', () => {
    const more: TemplateCatalogs = { ...CATALOGS, COST_CENTERS: [...(CATALOGS.COST_CENTERS ?? []), { code: '9999', name: 'Nuevo' }] };
    for (const target of IMPORT_TARGETS as ReadonlyArray<ImportTarget>) {
      expect(templateVersion(target)).toMatch(/^[0-9a-f]{10}$/);
      expect(templateVersion(target)).toBe(definitionHash(target).slice(0, 10));
    }
    expect(contentHash('ASSETS', more)).not.toBe(contentHash('ASSETS', CATALOGS));
    expect(contentHash('COST_CENTERS', more)).toBe(contentHash('COST_CENTERS', CATALOGS));
    expect(new Set(IMPORT_TARGETS.map(templateVersion)).size).toBe(3);
  });

  it('la plantilla de personas pide el nombre partido, no el nombre completo', () => {
    const names = templateFields('PERSONS').map(([name]) => name);
    expect(names).toEqual(expect.arrayContaining(['firstName', 'lastName', 'email', 'documentType']));
    expect(names).not.toContain('fullName');
  });

  it('código de catálogo: valor del desplegable o código solo; guiones dentro del código se respetan', () => {
    expect(catalogCode('4360 — DEPARTAMENTO DE FINANZAS ESTUDIANTILES')).toBe('4360');
    expect(catalogCode('CC - Cédula')).toBe('CC');
    expect(catalogCode('4360')).toBe('4360');
    expect(catalogCode('NO-EXISTE-1')).toBe('NO-EXISTE-1');
    expect(catalogCode('01979')).toBe('01979');
  });

  it('un Excel cualquiera no se toma por plantilla', () => {
    expect(readTemplateMarker([{ cells: { A: 'formato', B: 'otra cosa' } }])).toBeNull();
    expect(readTemplateMarker([])).toBeNull();
  });
});
