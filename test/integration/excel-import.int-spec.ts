import type { TestingModule } from '@nestjs/testing';
import ExcelJS from 'exceljs';
import { DataSource } from 'typeorm';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';
import { ExcelImportService } from '../../src/modules/staging/services/excel-import.service.js';
import { StagingModule } from '../../src/modules/staging/staging.module.js';
import { bootModules, createActor, scalar } from './helpers.js';

type Cell = string | number | Date | null;

const workbook = async (sheet: string, rows: Record<number, Cell[]>): Promise<Buffer> => {
  const book = new ExcelJS.Workbook();
  const ws = book.addWorksheet(sheet);
  for (const [rowNumber, values] of Object.entries(rows)) {
    const row = ws.getRow(Number(rowNumber));
    values.forEach((value, index) => {
      if (value !== null) {
        row.getCell(index + 1).value = value;
      }
    });
    row.commit();
  }
  return Buffer.from(await book.xlsx.writeBuffer());
};

const ASSET_MAPPING = {
  legacyAssetId: 'A',
  legacyCode: 'B',
  description: 'C',
  costCenterCode: 'D',
  acquisitionDate: 'E',
  acquisitionPrice: 'F',
};

const ASSET_ROWS: Record<number, Cell[]> = {
  1: ['INVENTARIO DE ACTIVOS 2026', null, null, null, null, null],
  2: ['Id', 'Codigo', 'Descripcion', 'Centro', 'Fecha compra', 'Precio'],
  3: [1, 'A-001', 'Portátil', '100', new Date('2020-01-01'), 3500000],
  4: [2, 'TEMP', 'Silla', '100', new Date('2019-01-01'), 150000],
  5: [3, 'D-001', 'Monitor', '200', new Date('2021-01-01'), 800000],
  6: [4, 'D-001', 'Monitor', '200', new Date('2021-01-01'), 800000],
  7: [5, null, 'Sin código', '100', new Date('2021-01-01'), 10000],
  8: [6, 'A-002', 'Sin fecha', '100', null, 10000],
  9: [7, 'A-003', 'Precio cero', '100', new Date('2021-01-01'), 0],
  10: [8, 'A-004', 'Centro inexistente', '9999', new Date('2021-01-01'), 10000],
  12: [null, null, null, '100', null, 5],
  13: [9, 'A-005', 'ID repetido', '100', new Date('2021-01-01'), 10000],
  14: [9, 'A-006', 'ID repetido', '100', new Date('2021-01-01'), 10000],
  15: [10, 'A-007', null, '100', new Date('2021-01-01'), 10000],
};

describe('Importación de Excel como funcionalidad (PostgreSQL real)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let imports: ExcelImportService;
  let actor: AuthenticatedUser;

  beforeAll(async () => {
    moduleRef = await bootModules(StagingModule);
    dataSource = moduleRef.get(DataSource);
    imports = moduleRef.get(ExcelImportService);
    actor = await createActor(dataSource);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  const count = (sql: string, params: unknown[] = []) => scalar<string>(dataSource, sql, params).then(Number);

  it('importa el catálogo de centros de costo solo con lo nuevo', async () => {
    const file = await workbook('Centros', { 1: ['Codigo', 'Nombre'], 2: ['100', 'Control Interno'], 3: [200, 'Talento Humano'] });
    const upload = await imports.upload(file, 'centros.xlsx', actor.id);
    expect(upload.sheets[0]).toMatchObject({ name: 'Centros', detectedHeaderRow: 1, columns: { A: 'Codigo', B: 'Nombre' } });
    const preview = await imports.preview(upload.batchId, { sheet: 'Centros', target: 'COST_CENTERS', mapping: { code: 'A', name: 'B' } }, actor.id);
    expect(preview.summary).toMatchObject({ rowsRead: 2, toInsert: 2, alreadyPresent: 0 });
    expect(await imports.confirm(preview.importId, actor.id)).toMatchObject({ inserted: 2, skippedAlreadyPresent: 0 });
  });

  it('previsualiza sin escribir, confirma con cuarentena y banderas, y no duplica al repetir', async () => {
    const file = await workbook('Hoja1', ASSET_ROWS);
    const upload = await imports.upload(file, 'activos.xlsx', actor.id);
    expect(upload.sheets[0]).toMatchObject({ detectedHeaderRow: 2, columns: { A: 'Id', B: 'Codigo', D: 'Centro' } });

    const assetsBefore = await count('SELECT count(*) FROM asset');
    const preview = await imports.preview(upload.batchId, { sheet: 'Hoja1', target: 'ASSETS', mapping: ASSET_MAPPING }, actor.id);
    expect(await count('SELECT count(*) FROM asset')).toBe(assetsBefore);
    expect(preview.summary).toMatchObject({
      rowsRead: 13,
      toInsert: 7,
      alreadyPresent: 0,
      quarantined: {
        EMPTY_ROW: 1,
        ROW_WITHOUT_ASSET_ID: 1,
        ASSET_ID_DUPLICATED: 2,
        COST_CENTER_UNKNOWN: 1,
        REQUIRED_FIELD_MISSING: 1,
      },
      flagged: {
        BARCODE_TEMP: 1,
        BARCODE_DUPLICATED: 2,
        BARCODE_EMPTY: 1,
        ACQUISITION_DATE_MISSING: 1,
        PRICE_ZERO: 1,
      },
    });
    const issues = await imports.issues(preview.importId, 1, 100);
    expect(issues.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rowNumber: 4, code: 'BARCODE_TEMP' }),
        expect.objectContaining({ rowNumber: 10, code: 'COST_CENTER_UNKNOWN' }),
        expect.objectContaining({ rowNumber: 15, code: 'REQUIRED_FIELD_MISSING' }),
      ]),
    );

    const result = await imports.confirm(preview.importId, actor.id);
    expect(result).toMatchObject({ inserted: 7, skippedAlreadyPresent: 0, registrationMovements: 7 });
    const quarantine = await imports.quarantine(preview.importId);
    expect(quarantine).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rowNumber: 10, legacyAssetId: '8', reason: 'COST_CENTER_UNKNOWN', detail: 'Centro de costo 9999' }),
        expect.objectContaining({ rowNumber: 11, reason: 'EMPTY_ROW' }),
        expect.objectContaining({ rowNumber: 12, reason: 'ROW_WITHOUT_ASSET_ID' }),
      ]),
    );
    expect(quarantine).toHaveLength(6);
    const reconciliation = await imports.reconcile(preview.importId);
    expect(reconciliation.filter((row) => !row.matches)).toEqual([]);
    expect(reconciliation.find((row) => row.check === 'Código TEMP')).toMatchObject({ diagnostic: 1, model: 1, quarantined: 0 });
    expect(reconciliation.find((row) => row.check === 'Centro de costo inexistente')).toMatchObject({ diagnostic: 1, model: 0, quarantined: 1 });

    const imported = `SELECT a.id FROM asset a JOIN asset_import_origin o ON o.asset_id = a.id WHERE o.import_id = $1`;
    expect(await count(`SELECT count(*) FROM (${imported}) x`, [preview.importId])).toBe(7);
    expect(await count(`SELECT count(*) FROM asset_identifier WHERE identifier_type = 'VISIBLE_CODE' AND asset_id IN (${imported})`, [preview.importId])).toBe(0);
    expect(await count(`SELECT count(*) FROM asset_identifier WHERE identifier_type = 'OPAQUE_ID' AND asset_id IN (${imported})`, [preview.importId])).toBe(7);
    expect(await count(`SELECT count(*) FROM asset_identifier WHERE identifier_type = 'LEGACY_CODE' AND asset_id IN (${imported})`, [preview.importId])).toBe(6);
    expect(await count(`SELECT count(*) FROM asset WHERE 'BARCODE_TEMP' = ANY(data_quality_flags) AND id IN (${imported})`, [preview.importId])).toBe(1);

    const again = await imports.upload(file, 'activos.xlsx', actor.id);
    expect(again).toMatchObject({ batchId: upload.batchId, created: false });
    const secondPreview = await imports.preview(again.batchId, { sheet: 'Hoja1', target: 'ASSETS', mapping: ASSET_MAPPING }, actor.id);
    expect(secondPreview.summary).toMatchObject({ toInsert: 0, alreadyPresent: 7 });
    const assetsAfterFirst = await count('SELECT count(*) FROM asset');
    expect(await imports.confirm(secondPreview.importId, actor.id)).toMatchObject({ inserted: 0, skippedAlreadyPresent: 7 });
    expect(await count('SELECT count(*) FROM asset')).toBe(assetsAfterFirst);
  });

  it('un archivo editado solo inserta filas nuevas; no actualiza las existentes', async () => {
    const edited = await workbook('Hoja1', {
      ...ASSET_ROWS,
      3: [1, 'A-001', 'Portátil RENOMBRADO', '100', new Date('2020-01-01'), 3500000],
      16: [11, 'A-008', 'Fila nueva', '200', new Date('2022-01-01'), 20000],
    });
    const upload = await imports.upload(edited, 'activos-v2.xlsx', actor.id);
    expect(upload.created).toBe(true);
    const preview = await imports.preview(upload.batchId, { sheet: 'Hoja1', target: 'ASSETS', mapping: ASSET_MAPPING }, actor.id);
    expect(preview.summary).toMatchObject({ toInsert: 1, alreadyPresent: 7 });
    expect(await imports.confirm(preview.importId, actor.id)).toMatchObject({ inserted: 1, skippedAlreadyPresent: 7 });
    expect(
      await scalar<string>(dataSource, `SELECT a.description FROM asset a JOIN asset_import_origin o ON o.asset_id = a.id WHERE o.legacy_asset_id = '1'`),
    ).toBe('Portátil');
  });

  it('con la política create, crea el centro inexistente y marca el activo', async () => {
    const file = await workbook('Hoja1', {
      1: ['Id', 'Codigo', 'Descripcion', 'Centro', 'Fecha compra', 'Precio'],
      2: [50, 'C-050', 'En centro nuevo', '8888', new Date('2021-01-01'), 1000],
    });
    const upload = await imports.upload(file, 'centro-nuevo.xlsx', actor.id);
    const preview = await imports.preview(
      upload.batchId,
      { sheet: 'Hoja1', target: 'ASSETS', mapping: ASSET_MAPPING, unknownCostCenters: 'create' },
      actor.id,
    );
    expect(preview.summary).toMatchObject({ toInsert: 1, quarantined: {} });
    expect(await count(`SELECT count(*) FROM cost_center WHERE external_code = '8888'`)).toBe(0);
    expect(await imports.confirm(preview.importId, actor.id)).toMatchObject({ inserted: 1, costCentersCreated: 1 });
    expect(
      await scalar<boolean>(
        dataSource,
        `SELECT 'COST_CENTER_NOT_IN_CATALOG' = ANY(a.data_quality_flags) FROM asset a JOIN asset_import_origin o ON o.asset_id = a.id WHERE o.legacy_asset_id = '50'`,
      ),
    ).toBe(true);
  });

  it('rechaza un mapeo sin campos obligatorios o con campos desconocidos', async () => {
    const file = await workbook('Hoja1', { 1: ['Id', 'Codigo'], 2: [99, 'X'] });
    const upload = await imports.upload(file, 'malo.xlsx', actor.id);
    await expect(
      imports.preview(upload.batchId, { sheet: 'Hoja1', target: 'ASSETS', mapping: { legacyAssetId: 'A', color: 'B' } }, actor.id),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
