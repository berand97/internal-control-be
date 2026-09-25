import type { TestingModule } from '@nestjs/testing';
import ExcelJS from 'exceljs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { writeIssuesCsv } from '../../src/modules/staging/report/write-issues-csv.js';
import { StagingDiagnosticsService } from '../../src/modules/staging/services/staging-diagnostics.service.js';
import { StagingLoaderService } from '../../src/modules/staging/services/staging-loader.service.js';
import { StagingModule } from '../../src/modules/staging/staging.module.js';
import { bootModules, scalar } from './helpers.js';

const HEADERS = [
  'MovIdActivo',
  'MovCodBarras',
  'MovDescripcion',
  'MovModelo',
  'MovNumSerie',
  'MovIdCentro',
  'MovFechaCompra',
  'MovPrecioCompra',
];

type Row = [number | null, unknown, string, unknown, unknown, unknown, unknown, unknown];

const ASSET_ROWS: Record<number, Row> = {
  2: [1, 'A-001', 'Portátil', 'Latitude', null, '100', new Date('2019-05-10'), 3500000],
  3: [2, 'TEMP', 'Silla', null, null, '100', new Date('2018-01-01'), 150000],
  4: [3, ' temp ', 'Mesa', null, null, '200', new Date('2018-01-01'), 200000],
  5: [4, 'D-001', 'Monitor', null, null, '100', new Date('2020-01-01'), 800000],
  6: [5, 'D-001', 'Monitor', null, null, '100', new Date('2020-01-01'), 800000],
  7: [6, 'D-001', 'Monitor', null, null, '200', new Date('2020-01-01'), 800000],
  9: [7, 'A-002', 'Sin fecha', null, null, '100', null, 100000],
  10: [8, 'A-003', 'Fecha número', null, null, '100', 2019, 100000],
  11: [9, 'A-004', 'Fecha texto', null, null, '100', '12/05/2019', 100000],
  12: [10, 'A-005', 'Fecha 1970', null, null, '100', new Date('1970-01-01'), 100000],
  13: [11, 'A-006', 'Precio cero', null, null, '100', new Date('2021-03-03'), 0],
  14: [12, 'A-007', 'Centro inexistente', null, null, '9999', new Date('2021-03-03'), 100000],
  15: [13, 'A-008', 'Precio texto', null, null, '100', new Date('2021-03-03'), 'abc'],
  16: [14, 'A-009', 'Precio #N/A', null, null, '100', new Date('2021-03-03'), { formula: 'NA()', result: { error: '#N/A' } }],
  17: [null, null, '', null, null, 'MovIdCentro', null, null],
  18: [null, null, '', null, null, '100', 5, null],
};

const buildAssetReport = async (path: string): Promise<void> => {
  const workbook = new ExcelJS.Workbook();
  const assets = workbook.addWorksheet('ACTIVOS');
  assets.addRow(HEADERS);
  for (const [rowNumber, values] of Object.entries(ASSET_ROWS)) {
    const row = assets.getRow(Number(rowNumber));
    values.forEach((value, index) => {
      if (value !== null) {
        row.getCell(index + 1).value = value as ExcelJS.CellValue;
      }
    });
    row.commit();
  }
  const writtenOff = workbook.addWorksheet('ACTIVOS DADOS DE BAJA');
  writtenOff.addRow([...HEADERS, 'MovDebaja', 'MovFechaDebaja']);
  writtenOff.addRow([99, 'B-001', 'Baja fechada', null, null, '100', new Date('2010-01-01'), 50000, true, new Date('2012-05-05')]);
  writtenOff.addRow([100, 'B-002', 'Baja sin fecha', null, null, '100', new Date('2015-01-01'), 50000, true, null]);
  writtenOff.addRow([101, 'B-003', 'Baja antes de compra', null, null, '100', new Date('2015-01-01'), 50000, true, new Date('2014-01-01')]);
  writtenOff.addRow([102, 'B-004', 'Baja fechada', null, null, '100', new Date('2016-01-01'), 50000, true, new Date('2020-02-02')]);
  writtenOff.addRow([99, 'B-005', 'ID repetido', null, null, '100', new Date('2010-01-01'), 50000, true, new Date('2012-05-05')]);
  const lookup = workbook.addWorksheet('Hoja2');
  lookup.getRow(2).values = [null, 'Codigo', 'Nombre'];
  lookup.getRow(3).values = [null, 100, 'Control Interno'];
  lookup.getRow(4).values = [null, 200, 'Talento Humano'];
  await workbook.xlsx.writeFile(path);
};

const buildCostCenters = async (path: string): Promise<void> => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('2026');
  sheet.getCell('A1').value = 'UNIVERSIDAD ADVENTISTA DE COLOMBIA';
  sheet.getCell('A2').value = 'Centros de costo 2026';
  sheet.getRow(3).values = ['CÓDIGO', 'NOMBRE'];
  sheet.addRow(['100', 'Control Interno']);
  sheet.addRow([200, 'Talento Humano']);
  await workbook.xlsx.writeFile(path);
};

describe('Staging de Excel y diagnóstico (PostgreSQL real)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let loader: StagingLoaderService;
  let diagnostics: StagingDiagnosticsService;
  let dir: string;
  let reportPath: string;
  let centersPath: string;

  beforeAll(async () => {
    moduleRef = await bootModules(StagingModule);
    dataSource = moduleRef.get(DataSource);
    loader = moduleRef.get(StagingLoaderService);
    diagnostics = moduleRef.get(StagingDiagnosticsService);
    dir = await mkdtemp(join(tmpdir(), 'staging-it-'));
    reportPath = join(dir, 'informe.xlsx');
    centersPath = join(dir, 'centros.xlsx');
    await buildAssetReport(reportPath);
    await buildCostCenters(centersPath);
  });

  afterAll(async () => {
    await moduleRef.close();
    await rm(dir, { recursive: true, force: true });
  });

  const modelCounts = async () => ({
    asset: await scalar<string>(dataSource, 'SELECT count(*) FROM asset'),
    costCenter: await scalar<string>(dataSource, 'SELECT count(*) FROM cost_center'),
    person: await scalar<string>(dataSource, 'SELECT count(*) FROM person'),
  });

  it('carga filas tal cual, con número de fila y tipo de celda, sin tocar el modelo', async () => {
    const before = await modelCounts();
    const result = await loader.load(reportPath, 'ASSET_REPORT');
    expect(result.created).toBe(true);
    expect(result.sheets).toEqual([
      { name: 'ACTIVOS', rows: 18 },
      { name: 'ACTIVOS DADOS DE BAJA', rows: 6 },
      { name: 'Hoja2', rows: 4 },
    ]);
    const cell = async (rowNumber: number, column: string) =>
      (
        (await dataSource.query(
          `SELECT cells -> $3 AS value, cell_types ->> $3 AS type FROM staging_row
           WHERE batch_id = $1 AND sheet_name = 'ACTIVOS' AND row_number = $2`,
          [result.batchId, rowNumber, column],
        )) as Array<{ value: unknown; type: string | null }>
      )[0];
    expect(await cell(2, 'G')).toEqual({ value: '2019-05-10T00:00:00.000Z', type: 'date' });
    expect(await cell(10, 'G')).toEqual({ value: 2019, type: 'number' });
    expect(await cell(11, 'G')).toEqual({ value: '12/05/2019', type: 'string' });
    expect(await cell(4, 'B')).toEqual({ value: ' temp ', type: 'string' });
    expect(await cell(16, 'H')).toEqual({ value: '#N/A', type: 'formula:error' });
    expect(await cell(8, 'A')).toEqual({ value: null, type: null });
    expect(await modelCounts()).toEqual(before);
  });

  it('cargar el mismo archivo dos veces no duplica', async () => {
    const first = await loader.load(reportPath, 'ASSET_REPORT');
    const second = await loader.load(reportPath, 'ASSET_REPORT');
    expect(second).toEqual({ ...first, created: false });
    expect(
      Number(await scalar<string>(dataSource, 'SELECT count(*) FROM staging_row WHERE batch_id = $1', [first.batchId])),
    ).toBe(28);
    expect(Number(await scalar<string>(dataSource, `SELECT count(*) FROM staging_batch WHERE source_kind = 'ASSET_REPORT'`))).toBe(1);
  });

  it('diagnostica cada tipo de problema con su fila original', async () => {
    const report = await loader.load(reportPath, 'ASSET_REPORT');
    const centers = await loader.load(centersPath, 'COST_CENTERS');
    const diagnosis = await diagnostics.diagnoseAssetReport(report.batchId, centers.batchId);

    const active = diagnosis.sheets.find((sheet) => sheet.sheet === 'ACTIVOS');
    const metric = (key: string) => active?.metrics.find((item) => item.key === key)?.value;
    expect({
      rowsRead: metric('rows_read'),
      rows: metric('rows'),
      withoutAssetId: metric('rows_without_asset_id'),
      temp: metric('barcode_temp'),
      duplicatedCodes: metric('barcode_duplicated_codes'),
      duplicatedRows: metric('barcode_duplicated_rows'),
      emptyRows: metric('empty_rows'),
      missingDate: metric('purchase_date_missing'),
      notADate: metric('purchase_date_not_a_date'),
      epoch: metric('purchase_date_epoch'),
      priceZero: metric('price_zero'),
      priceNotNumber: metric('price_not_a_number'),
      unknownCenterCodes: metric('cost_center_unknown_codes'),
      unknownCenterAssets: metric('cost_center_unknown_assets'),
      serialEmpty: metric('serial_empty'),
      modelEmpty: metric('model_empty'),
    }).toEqual({
      rowsRead: 17,
      rows: 14,
      withoutAssetId: 2,
      temp: 2,
      duplicatedCodes: 1,
      duplicatedRows: 3,
      emptyRows: 1,
      missingDate: 1,
      notADate: 2,
      epoch: 1,
      priceZero: 1,
      priceNotNumber: 2,
      unknownCenterCodes: 1,
      unknownCenterAssets: 1,
      serialEmpty: 14,
      modelEmpty: 13,
    });
    expect(diagnosis.otherSheets).toEqual([
      { name: 'Hoja2', headerRow: 2, nonEmptyRows: 2, headers: ['Codigo', 'Nombre'] },
    ]);
    expect(diagnosis.relations).toEqual([
      { left: 'ACTIVOS', right: 'ACTIVOS DADOS DE BAJA', sharedIds: 0, identicalRows: 0, commonColumns: 8 },
    ]);
    const writeOffs = diagnosis.sheets.find((sheet) => sheet.sheet === 'ACTIVOS DADOS DE BAJA');
    const writeOffMetric = (key: string) => writeOffs?.metrics.find((item) => item.key === key)?.value;
    expect({
      rows: writeOffMetric('rows'),
      repeatedIds: writeOffMetric('asset_id_duplicated_ids'),
      writtenOff: writeOffMetric('written_off'),
      withDate: writeOffMetric('write_off_date_present'),
      withoutDate: writeOffMetric('write_off_date_missing'),
      beforePurchase: writeOffMetric('write_off_before_purchase'),
    }).toEqual({ rows: 5, repeatedIds: 1, writtenOff: 5, withDate: 4, withoutDate: 1, beforePurchase: 1 });
    expect(
      await dataSource.query(
        `SELECT row_number, issue_code FROM staging_issue
         WHERE batch_id = $1 AND sheet_name = 'ACTIVOS DADOS DE BAJA' ORDER BY row_number, issue_code`,
        [report.batchId],
      ),
    ).toEqual([
      { row_number: 2, issue_code: 'ASSET_ID_DUPLICATED' },
      { row_number: 3, issue_code: 'WRITE_OFF_DATE_MISSING' },
      { row_number: 4, issue_code: 'WRITE_OFF_BEFORE_PURCHASE' },
      { row_number: 6, issue_code: 'ASSET_ID_DUPLICATED' },
    ]);

    const issues = (await dataSource.query(
      `SELECT row_number, issue_code FROM staging_issue
       WHERE batch_id = $1 AND sheet_name = 'ACTIVOS' ORDER BY row_number, issue_code`,
      [report.batchId],
    )) as Array<{ row_number: number; issue_code: string }>;
    expect(issues).toEqual([
      { row_number: 3, issue_code: 'BARCODE_TEMP' },
      { row_number: 4, issue_code: 'BARCODE_TEMP' },
      { row_number: 5, issue_code: 'BARCODE_DUPLICATED' },
      { row_number: 6, issue_code: 'BARCODE_DUPLICATED' },
      { row_number: 7, issue_code: 'BARCODE_DUPLICATED' },
      { row_number: 8, issue_code: 'EMPTY_ROW' },
      { row_number: 9, issue_code: 'PURCHASE_DATE_MISSING' },
      { row_number: 10, issue_code: 'PURCHASE_DATE_NOT_A_DATE' },
      { row_number: 11, issue_code: 'PURCHASE_DATE_NOT_A_DATE' },
      { row_number: 12, issue_code: 'PURCHASE_DATE_EPOCH' },
      { row_number: 13, issue_code: 'PRICE_ZERO' },
      { row_number: 14, issue_code: 'COST_CENTER_UNKNOWN' },
      { row_number: 15, issue_code: 'PRICE_NOT_A_NUMBER' },
      { row_number: 16, issue_code: 'PRICE_NOT_A_NUMBER' },
      { row_number: 17, issue_code: 'ROW_WITHOUT_ASSET_ID' },
      { row_number: 18, issue_code: 'ROW_WITHOUT_ASSET_ID' },
    ]);

    const again = await diagnostics.diagnoseAssetReport(report.batchId, centers.batchId);
    expect(again.issues).toHaveLength(diagnosis.issues.length);
    expect(
      Number(await scalar<string>(dataSource, 'SELECT count(*) FROM staging_issue WHERE batch_id = $1', [report.batchId])),
    ).toBe(diagnosis.issues.length);

    const out = join(dir, 'problemas.csv');
    await writeIssuesCsv(out, diagnosis.issues);
    const csv = await readFile(out, 'utf8');
    expect(
      csv.startsWith('﻿Hoja;Fila;Columna;Problema;Valor encontrado;Detalle;Código\r\n'),
    ).toBe(true);
    const lines = csv.slice(1).trimEnd().split('\r\n');
    expect(lines).toHaveLength(diagnosis.issues.length + 1);
    expect(lines).toContain(
      'ACTIVOS;11;MovFechaCompra;La fecha de compra no es una fecha;12/05/2019;Tipo de celda: string;PURCHASE_DATE_NOT_A_DATE',
    );
  });
});
