// Plantillas Excel de importación (PostgreSQL real + storage del proyecto): generadas desde la definición, guardadas
// en el storage y regeneradas solo si cambia la definición o un catálogo; reconocidas al subir (versión, mapeo,
// fila de ejemplo ignorada); plantillas viejas y columnas extra no rompen nada; un Excel cualquiera sigue igual.
import type { TestingModule } from '@nestjs/testing';
import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { DataSource } from 'typeorm';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';
import type { ImportTarget } from '../../src/modules/staging/import/import-fields.js';
import { readWorkbook } from '../../src/modules/staging/excel/read-workbook.js';
import { ExcelImportService } from '../../src/modules/staging/services/excel-import.service.js';
import { ImportJobsService } from '../../src/modules/staging/services/import-jobs.service.js';
import { StagingModule } from '../../src/modules/staging/staging.module.js';
import {
  DATA_SHEET_NAME,
  META_SHEET,
  templateVersion,
} from '../../src/modules/staging/templates/import-template.js';
import { ImportTemplateService } from '../../src/modules/staging/templates/import-template.service.js';
import { bootModules, createActor, scalar, useSharedStorage } from './helpers.js';

type Cell = string | number | Date | null;

const load = async (body: Buffer): Promise<ExcelJS.Workbook> => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(body as unknown as ArrayBuffer);
  return workbook;
};

const save = async (workbook: ExcelJS.Workbook): Promise<Buffer> => Buffer.from(await workbook.xlsx.writeBuffer());

/** Llena la hoja de datos de una plantilla desde la fila 3 (la 2 es el ejemplo), por encabezado. */
const fill = (sheet: ExcelJS.Worksheet, rows: ReadonlyArray<Record<string, Cell>>): void => {
  const letters = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, column) => letters.set(String(cell.value), column));
  rows.forEach((values, index) => {
    const row = sheet.getRow(3 + index);
    for (const [header, value] of Object.entries(values)) {
      const column = letters.get(header);
      if (column === undefined) {
        throw new Error(`La plantilla no tiene la columna ${header}`);
      }
      if (value !== null) {
        row.getCell(column).value = value;
      }
    }
    row.commit();
  });
};

const setMeta = (workbook: ExcelJS.Workbook, key: string, value: string): void => {
  const meta = workbook.getWorksheet(META_SHEET);
  meta?.eachRow((row) => {
    if (row.getCell(1).value === key) {
      row.getCell(2).value = value;
    }
  });
};

/**
 * Simula una plantilla de una versión anterior a partir de la vigente con una columna menos: otra versión y la fila
 * de ejemplo registrada tal como quedó (una plantilla vieja real trae su propio ejemplo coherente con sus columnas).
 */
const asOlderVersion = async (workbook: ExcelJS.Workbook, target: ImportTarget): Promise<void> => {
  setMeta(workbook, 'version', '0000000old');
  const sheets = await readWorkbook(await save(workbook));
  const example = sheets.find((sheet) => sheet.name === DATA_SHEET_NAME[target])?.rows.find((row) => row.rowNumber === 2);
  setMeta(workbook, 'ejemplo', JSON.stringify(example?.cells ?? {}));
};

describe('Plantillas Excel de importación (PostgreSQL real)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let imports: ExcelImportService;
  let templates: ImportTemplateService;
  let actor: AuthenticatedUser;
  let center: string;
  let otherCenter: string;
  const tag = () => randomUUID().replace(/\D/g, '').padEnd(8, '7').slice(0, 8);
  const count = (sql: string, params: unknown[] = []) => scalar<string>(dataSource, sql, params).then(Number);
  const download = async (target: ImportTarget) => load((await templates.download(target, actor.id)).body);

  beforeAll(async () => {
    moduleRef = await bootModules(StagingModule);
    dataSource = moduleRef.get(DataSource);
    imports = moduleRef.get(ExcelImportService);
    templates = moduleRef.get(ImportTemplateService);
    actor = await createActor(dataSource);
    await useSharedStorage(dataSource);
    center = `T${tag().slice(0, 5)}`;
    otherCenter = `U${tag().slice(0, 5)}`;
    await dataSource.query(
      `INSERT INTO cost_center (external_code, name) VALUES ($1, 'DEPARTAMENTO DE FINANZAS ESTUDIANTILES'), ($2, 'OTRO')`,
      [center, otherCenter],
    );
    await dataSource.query(
      `INSERT INTO asset_category (code, name) VALUES ('TPL_COMPUTO', 'Equipo de cómputo') ON CONFLICT (code) DO NOTHING`,
    );
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('se genera una vez por contenido, se sirve desde el storage y se regenera solo si cambia un catálogo', async () => {
    const before = await count('SELECT count(*) FROM import_template');
    const first = await templates.list(actor.id);
    expect(first.map((item) => [item.target, item.version])).toEqual([
      ['ASSETS', templateVersion('ASSETS')],
      ['COST_CENTERS', templateVersion('COST_CENTERS')],
      ['PERSONS', templateVersion('PERSONS')],
    ]);
    const generated = await count('SELECT count(*) FROM import_template');
    expect(generated).toBeGreaterThanOrEqual(before);

    const a = await templates.download('PERSONS', actor.id);
    const b = await templates.download('PERSONS', actor.id);
    expect(b.body.equals(a.body)).toBe(true);
    expect(await count('SELECT count(*) FROM import_template')).toBe(generated);
    const [row] = (await dataSource.query(
      `SELECT storage_key, storage_driver, file_name FROM import_template WHERE target = 'PERSONS' ORDER BY generated_at DESC LIMIT 1`,
    )) as Array<{ storage_key: string; storage_driver: string; file_name: string }>;
    expect(row).toMatchObject({ storage_driver: 'project', file_name: a.fileName });
    expect(row?.storage_key).toMatch(new RegExp(`^import-templates/PERSONS/${templateVersion('PERSONS')}/`));

    // Un centro nuevo cambia el catálogo: otro archivo, misma versión. COST_CENTERS no usa ese catálogo: no cambia.
    await dataSource.query(`INSERT INTO cost_center (external_code, name) VALUES ($1, 'Centro nuevo')`, [`V${tag().slice(0, 5)}`]);
    const after = await templates.list(actor.id);
    expect(await count('SELECT count(*) FROM import_template')).toBe(generated + 2);
    expect(after.find((item) => item.target === 'PERSONS')?.version).toBe(templateVersion('PERSONS'));
    expect(after.find((item) => item.target === 'PERSONS')?.contentHash).not.toBe(
      first.find((item) => item.target === 'PERSONS')?.contentHash,
    );
    expect(after.find((item) => item.target === 'COST_CENTERS')?.contentHash).toBe(
      first.find((item) => item.target === 'COST_CENTERS')?.contentHash,
    );
    const catalogCounts = after.find((item) => item.target === 'ASSETS')?.catalogCounts;
    expect(catalogCounts?.['PHYSICAL_CONDITIONS']).toBe(5);
    expect(catalogCounts?.['COST_CENTERS']).toBe(await count('SELECT count(*) FROM cost_center'));
  });

  it('personas: plantilla llenada → versión detectada, mapeo automático, ejemplo ignorado, 01979 y códigos resueltos', async () => {
    const workbook = await download('PERSONS');
    const sheet = workbook.getWorksheet(DATA_SHEET_NAME.PERSONS);
    if (!sheet) {
      throw new Error('sin hoja de datos');
    }
    const base = tag();
    fill(sheet, [
      {
        'Tipo de documento': 'CC — Cédula de ciudadanía',
        'Número de documento': `01979${base}`,
        Nombres: 'ANA MARÍA',
        Apellidos: 'LÓPEZ RÍOS',
        Cargo: 'Analista',
        'Correo institucional': `ana.${base}@unac.edu.co`,
        'Centro de costo': `${center} — DEPARTAMENTO DE FINANZAS ESTUDIANTILES`,
      },
      {
        'Tipo de documento': 'CE',
        'Número de documento': `X${base}`,
        Nombres: 'JUAN',
        Apellidos: 'PÉREZ',
        'Correo institucional': `juan.${base}@unac.edu.co`,
        'Centro de costo': otherCenter,
      },
      { 'Número de documento': `02${base}`, Nombres: 'SIN', Apellidos: 'CORREO' },
    ]);
    const upload = await imports.upload(await save(workbook), 'personas.xlsx', actor.id);
    expect(upload.sheets.map((item) => item.name)).toEqual([DATA_SHEET_NAME.PERSONS]);
    expect(upload.template).toMatchObject({
      target: 'PERSONS',
      version: templateVersion('PERSONS'),
      currentVersion: templateVersion('PERSONS'),
      outdated: false,
      knownVersion: true,
      dataSheet: DATA_SHEET_NAME.PERSONS,
      headerRow: 1,
      missingColumns: [],
    });
    const mapping = upload.template?.mapping ?? {};
    expect(Object.keys(mapping).sort()).toEqual(
      ['costCenterCode', 'documentNumber', 'documentType', 'email', 'firstName', 'lastName', 'positionTitle'].sort(),
    );

    const preview = await imports.preview(upload.batchId, { sheet: DATA_SHEET_NAME.PERSONS, target: 'PERSONS', mapping }, actor.id);
    expect(preview.summary).toMatchObject({
      rowsRead: 3,
      toInsert: 2,
      quarantined: { EMAIL_MISSING: 1 },
      unmappedColumns: [],
      template: { version: templateVersion('PERSONS'), outdated: false, exampleRowsIgnored: [2], missingColumns: [] },
    });
    expect(
      await scalar<string>(dataSource, 'SELECT template_version FROM staging_import WHERE id = $1', [preview.importId]),
    ).toBe(templateVersion('PERSONS'));
    const issues = await imports.issues(preview.importId, 1, 100);
    expect(issues.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ rowNumber: 2, code: 'TEMPLATE_EXAMPLE_ROW_IGNORED' })]),
    );

    expect(await moduleRef.get(ImportJobsService).runNow(preview.importId, actor.id)).toMatchObject({ inserted: 2 });
    const [ana] = (await dataSource.query(
      `SELECT p.document_type, p.document_number, cc.external_code FROM person p
       LEFT JOIN cost_center cc ON cc.id = p.cost_center_id WHERE p.document_number = $1`,
      [`01979${base}`],
    )) as Array<{ document_type: string; document_number: string; external_code: string }>;
    expect(ana).toEqual({ document_type: 'CC', document_number: `01979${base}`, external_code: center });
    expect(await count(`SELECT count(*) FROM person WHERE email = 'ejemplo.plantilla@unac.edu.co'`)).toBe(0);
  });

  it('plantilla vieja sin una columna: se importa con ese campo vacío, las reglas siguen y el diagnóstico lo dice', async () => {
    const workbook = await download('PERSONS');
    const sheet = workbook.getWorksheet(DATA_SHEET_NAME.PERSONS);
    if (!sheet) {
      throw new Error('sin hoja de datos');
    }
    const emailColumn = 6;
    expect(sheet.getRow(1).getCell(emailColumn).value).toBe('Correo institucional');
    sheet.spliceColumns(emailColumn, 1);
    await asOlderVersion(workbook, 'PERSONS');
    const base = tag();
    fill(sheet, [
      { 'Número de documento': `31${base}`, Nombres: 'VIEJA', Apellidos: 'PLANTILLA', 'Centro de costo': center },
    ]);
    const upload = await imports.upload(await save(workbook), 'personas-vieja.xlsx', actor.id);
    expect(upload.template).toMatchObject({
      version: '0000000old',
      currentVersion: templateVersion('PERSONS'),
      outdated: true,
      knownVersion: false,
      missingColumns: [{ field: 'email', header: 'Correo institucional', required: true }],
    });
    const mapping = upload.template?.mapping ?? {};
    expect(mapping['email']).toBeUndefined();
    const preview = await imports.preview(upload.batchId, { sheet: DATA_SHEET_NAME.PERSONS, target: 'PERSONS', mapping }, actor.id);
    // No se rechaza, y la validación no se relaja: sin correo, a cuarentena.
    expect(preview.summary).toMatchObject({
      rowsRead: 1,
      toInsert: 0,
      quarantined: { EMAIL_MISSING: 1 },
      template: {
        version: '0000000old',
        outdated: true,
        currentVersion: templateVersion('PERSONS'),
        missingColumns: [{ field: 'email', header: 'Correo institucional', required: true }],
      },
    });
    const issues = await imports.issues(preview.importId, 1, 100);
    expect(issues.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'TEMPLATE_OUTDATED', rowNumber: null }),
        expect.objectContaining({ code: 'TEMPLATE_COLUMN_MISSING', column: 'Correo institucional' }),
      ]),
    );
    expect(await scalar<string>(dataSource, 'SELECT template_version FROM staging_import WHERE id = $1', [preview.importId])).toBe(
      '0000000old',
    );
  });

  it('plantilla vieja sin una columna obligatoria del mapeo (Descripción): no se rechaza, cada fila a cuarentena', async () => {
    const workbook = await download('ASSETS');
    const sheet = workbook.getWorksheet(DATA_SHEET_NAME.ASSETS);
    if (!sheet) {
      throw new Error('sin hoja de datos');
    }
    expect(sheet.getRow(1).getCell(3).value).toBe('Descripción');
    sheet.spliceColumns(3, 1);
    await asOlderVersion(workbook, 'ASSETS');
    const base = tag();
    fill(sheet, [{ 'Identificador del activo': `OLD${base}`, 'Centro de costo': center }]);
    const upload = await imports.upload(await save(workbook), 'activos-vieja.xlsx', actor.id);
    const mapping = upload.template?.mapping ?? {};
    expect(mapping['description']).toBeUndefined();
    const preview = await imports.preview(upload.batchId, { sheet: DATA_SHEET_NAME.ASSETS, target: 'ASSETS', mapping }, actor.id);
    expect(preview.summary).toMatchObject({ rowsRead: 1, toInsert: 0, quarantined: { REQUIRED_FIELD_MISSING: 1 } });
    expect(preview.summary.template?.missingColumns).toEqual([{ field: 'description', header: 'Descripción', required: true }]);
    // Un Excel cualquiera sin esa columna sigue rechazando el mapeo, como siempre.
  });

  it('activos: columna extra reportada, 01979 preservado, catálogos resueltos, valores fuera de catálogo a cuarentena', async () => {
    const workbook = await download('ASSETS');
    const sheet = workbook.getWorksheet(DATA_SHEET_NAME.ASSETS);
    if (!sheet) {
      throw new Error('sin hoja de datos');
    }
    const lastColumn = sheet.getRow(1).cellCount + 1;
    sheet.getRow(1).getCell(lastColumn).value = 'Sede';
    const base = tag();
    const id = `01979${base}`;
    fill(sheet, [
      {
        'Identificador del activo': id,
        'Código de barras': '01979',
        Descripción: 'Portátil',
        'Centro de costo': `${center} — DEPARTAMENTO DE FINANZAS ESTUDIANTILES`,
        Categoría: 'TPL_COMPUTO — Equipo de cómputo',
        'Condición física': 'GOOD — Bueno',
        'Fecha de compra': new Date('2025-02-01T00:00:00Z'),
        'Precio de compra': 2500000,
      },
      { 'Identificador del activo': `B${base}`, Descripción: 'Silla', 'Centro de costo': center, Categoría: 'NO_EXISTE' },
      { 'Identificador del activo': `C${base}`, Descripción: 'Mesa', 'Centro de costo': center, 'Condición física': 'ROTO' },
    ]);
    sheet.getRow(3).getCell(lastColumn).value = 'Sede norte';
    const body = await save(workbook);
    const reread = await load(body);
    expect(reread.getWorksheet(DATA_SHEET_NAME.ASSETS)?.getRow(3).getCell(2).value).toBe('01979');
    expect(reread.getWorksheet(DATA_SHEET_NAME.ASSETS)?.getColumn(2).numFmt).toBe('@');

    const upload = await imports.upload(body, 'activos.xlsx', actor.id);
    const mapping = upload.template?.mapping ?? {};
    expect(Object.keys(mapping)).toHaveLength(13);
    const preview = await imports.preview(upload.batchId, { sheet: DATA_SHEET_NAME.ASSETS, target: 'ASSETS', mapping }, actor.id);
    expect(preview.summary).toMatchObject({
      rowsRead: 3,
      toInsert: 1,
      quarantined: { CATEGORY_UNKNOWN: 1, PHYSICAL_CONDITION_INVALID: 1 },
      unmappedColumns: [{ column: String.fromCharCode(64 + lastColumn), header: 'Sede' }],
      template: { exampleRowsIgnored: [2] },
    });
    // El diagnóstico no confunde el valor del desplegable con un centro inexistente.
    const issues = await imports.issues(preview.importId, 1, 100);
    expect(issues.items.filter((item) => item.code === 'COST_CENTER_UNKNOWN')).toEqual([]);
    expect(issues.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'COLUMN_UNMAPPED', column: 'Sede', rowNumber: null })]),
    );
    expect(await moduleRef.get(ImportJobsService).runNow(preview.importId, actor.id)).toMatchObject({ inserted: 1 });
    const [asset] = (await dataSource.query(
      `SELECT a.internal_code, a.barcode, cc.external_code FROM asset a JOIN asset_import_origin o ON o.asset_id = a.id
       JOIN cost_center cc ON cc.id = a.current_cost_center_id WHERE o.legacy_asset_id = $1`,
      [id],
    )) as Array<{ internal_code: string; barcode: string; external_code: string }>;
    expect(asset).toEqual({ internal_code: `XLS-${id}`, barcode: '01979', external_code: center });
    expect(await count(`SELECT count(*) FROM asset_import_origin WHERE legacy_asset_id = 'EJEMPLO-0001'`)).toBe(0);
    const reconciliation = await imports.reconcile(preview.importId);
    expect(reconciliation.find((item) => item.check === 'Filas leídas')).toMatchObject({ diagnostic: 3, matches: true });
  });

  it('una fila de ejemplo modificada deja de ser ejemplo y se importa como dato', async () => {
    const workbook = await download('COST_CENTERS');
    const sheet = workbook.getWorksheet(DATA_SHEET_NAME.COST_CENTERS);
    const code = `E${tag().slice(0, 5)}`;
    if (!sheet) {
      throw new Error('sin hoja de datos');
    }
    sheet.getRow(2).getCell(1).value = code;
    const upload = await imports.upload(await save(workbook), 'centros.xlsx', actor.id);
    const preview = await imports.preview(
      upload.batchId,
      { sheet: DATA_SHEET_NAME.COST_CENTERS, target: 'COST_CENTERS', mapping: upload.template?.mapping ?? {} },
      actor.id,
    );
    expect(preview.summary).toMatchObject({ rowsRead: 1, toInsert: 1, template: { exampleRowsIgnored: [] } });
  });

  it('un Excel cualquiera sigue funcionando: sin plantilla, versión NULL, columnas sin mapear reportadas', async () => {
    const book = new ExcelJS.Workbook();
    const ws = book.addWorksheet('Movimientos');
    ws.addRow(['MovIdActivo', 'MovCodBarras', 'MovDescripción', 'MovModelo', 'MovIdCuenta', 'MovIdCentro', 'MovFechaCompra', 'MovPrecioCompra', 'MovDebaja']);
    const base = tag();
    ws.addRow([`R${base}`, '00042', 'Escritorio', 'X', '1528', center, new Date('2020-01-01T00:00:00Z'), 900000, 'N']);
    ws.addRow([`S${base}`, 'TEMP', 'Silla', null, '1528', '9999', new Date('2020-01-01T00:00:00Z'), 0, 'N']);
    const upload = await imports.upload(await save(book), 'informe.xlsx', actor.id);
    expect(upload.template).toBeNull();
    expect(upload.sheets.map((item) => item.name)).toEqual(['Movimientos']);
    const mapping = { legacyAssetId: 'A', legacyCode: 'B', description: 'C', model: 'D', costCenterCode: 'F', acquisitionDate: 'G', acquisitionPrice: 'H' };
    const preview = await imports.preview(upload.batchId, { sheet: 'Movimientos', target: 'ASSETS', mapping }, actor.id);
    expect(preview.summary).toMatchObject({
      rowsRead: 2,
      toInsert: 1,
      quarantined: { COST_CENTER_UNKNOWN: 1 },
      template: null,
      unmappedColumns: [
        { column: 'E', header: 'MovIdCuenta' },
        { column: 'I', header: 'MovDebaja' },
      ],
    });
    expect(await scalar<string | null>(dataSource, 'SELECT template_version FROM staging_import WHERE id = $1', [preview.importId])).toBeNull();
    await expect(
      imports.preview(upload.batchId, { sheet: 'Movimientos', target: 'ASSETS', mapping: { legacyAssetId: 'A' } }, actor.id),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  // Opcional: el informe real de activos (REAL_ASSET_REPORT=<ruta>). No se versiona (datos institucionales).
  const realReport = process.env['REAL_ASSET_REPORT'];
  it.skipIf(!realReport || !existsSync(realReport))('el informe real de activos se sube y previsualiza como antes', async () => {
    const upload = await imports.upload(await readFile(realReport as string), 'informe-real.xlsx', actor.id);
    expect(upload.template).toBeNull();
    const sheet = upload.sheets.find((item) => item.name === 'Movimientos') ?? upload.sheets[0];
    const columns = sheet?.columns ?? {};
    const letter = (header: string) => Object.entries(columns).find(([, value]) => value === header)?.[0] ?? '';
    const mapping = {
      legacyAssetId: letter('MovIdActivo'),
      legacyCode: letter('MovCodBarras'),
      description: letter('MovDescripción'),
      costCenterCode: letter('MovIdCentro'),
      acquisitionDate: letter('MovFechaCompra'),
    };
    const preview = await imports.preview(upload.batchId, { sheet: sheet?.name ?? '', target: 'ASSETS', mapping }, actor.id);
    expect(preview.summary.template).toBeNull();
    expect(preview.summary.rowsRead).toBeGreaterThan(8000);
    expect(preview.summary.unmappedColumns.length).toBe(Object.keys(columns).length - 5);
    console.log(
      `informe real: filas=${preview.summary.rowsRead} aInsertar=${preview.summary.toInsert} cuarentena=${JSON.stringify(preview.summary.quarantined)} sinMapear=${preview.summary.unmappedColumns.map((item) => item.header).join('|')}`,
    );
  });
});
