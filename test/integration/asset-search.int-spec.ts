import type { TestingModule } from '@nestjs/testing';
import ExcelJS from 'exceljs';
import { existsSync, readFileSync } from 'node:fs';
import { DataSource } from 'typeorm';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';
import type { QueryAssetsDto } from '../../src/modules/assets/dto/query-assets.dto.js';
import { AssetsModule } from '../../src/modules/assets/assets.module.js';
import { AssetsService } from '../../src/modules/assets/services/assets.service.js';
import { ExcelImportService } from '../../src/modules/staging/services/excel-import.service.js';
import { StagingModule } from '../../src/modules/staging/staging.module.js';
import { bootModules, createActor } from './helpers.js';

const REAL_ASSETS = process.env['REAL_ASSET_WORKBOOK'] ?? 'docs/7.1 informe control activos julio 2026.xlsx';
const REAL_COST_CENTERS = process.env['REAL_COST_CENTER_WORKBOOK'] ?? 'docs/centros de costo.xlsx';

const workbook = async (sheet: string, rows: ReadonlyArray<ReadonlyArray<string | number | Date | null>>) => {
  const book = new ExcelJS.Workbook();
  const ws = book.addWorksheet(sheet);
  rows.forEach((values, index) => {
    const row = ws.getRow(index + 1);
    values.forEach((value, column) => {
      if (value !== null) {
        row.getCell(column + 1).value = value;
      }
    });
    row.commit();
  });
  return Buffer.from(await book.xlsx.writeBuffer());
};

const query = (values: Partial<QueryAssetsDto>): QueryAssetsDto =>
  ({ page: 1, pageSize: 100, sortOrder: 'desc', ...values }) as QueryAssetsDto;

describe('Búsqueda de activos por identificador y calidad de datos (PostgreSQL real)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let imports: ExcelImportService;
  let assets: AssetsService;
  let actor: AuthenticatedUser;

  const importAssets = async (file: Buffer, sheet: string, mapping: Record<string, string>) => {
    const upload = await imports.upload(file, `${sheet}.xlsx`, actor.id);
    const preview = await imports.preview(upload.batchId, { sheet, target: 'ASSETS', mapping }, actor.id);
    return imports.confirm(preview.importId, actor.id);
  };

  beforeAll(async () => {
    moduleRef = await bootModules(StagingModule, AssetsModule);
    dataSource = moduleRef.get(DataSource);
    imports = moduleRef.get(ExcelImportService);
    assets = moduleRef.get(AssetsService);
    actor = await createActor(dataSource);

    const centers = await workbook('Centros', [['Codigo', 'Nombre'], ['SRCH-1', 'Centro de búsqueda']]);
    const upload = await imports.upload(centers, 'centros-busqueda.xlsx', actor.id);
    const preview = await imports.preview(
      upload.batchId,
      { sheet: 'Centros', target: 'COST_CENTERS', mapping: { code: 'A', name: 'B' } },
      actor.id,
    );
    await imports.confirm(preview.importId, actor.id);

    const rows = await workbook('Busqueda', [
      ['Id', 'Codigo', 'Descripcion', 'Centro', 'Fecha compra', 'Precio'],
      [900001, 'PLACA-77123', 'Escritorio en L', 'SRCH-1', new Date('2020-01-01'), 900000],
      [900002, 'TEMP', 'Silla ergonómica busqueda', 'SRCH-1', new Date('2020-01-01'), 150000],
      [900003, 'TEMP', 'Archivador busqueda', 'SRCH-1', null, 300000],
      [900004, null, 'Tablero sin placa busqueda', 'SRCH-1', new Date('2020-01-01'), 50000],
      [900005, '100%_REAL', 'Código con comodines', 'SRCH-1', new Date('2020-01-01'), 50000],
    ]);
    await importAssets(rows, 'Busqueda', {
      legacyAssetId: 'A',
      legacyCode: 'B',
      description: 'C',
      costCenterCode: 'D',
      acquisitionDate: 'E',
      acquisitionPrice: 'F',
    });
  }, 120_000);

  afterAll(async () => {
    await moduleRef.close();
  });

  const assetIdOf = async (legacyAssetId: number): Promise<string> => {
    const [row] = (await dataSource.query('SELECT asset_id FROM asset_import_origin WHERE legacy_asset_id = $1', [
      String(legacyAssetId),
    ])) as Array<{ asset_id: string }>;
    return row?.asset_id ?? '';
  };

  it('encuentra un activo por su código heredado, parcial y sin distinguir mayúsculas', async () => {
    const id = await assetIdOf(900001);
    for (const q of ['PLACA-77123', 'placa-771', '77123']) {
      const page = await assets.list(query({ q }));
      expect(page.items.map((item) => item.id)).toEqual([id]);
    }
    const [found] = (await assets.list(query({ q: '77123' }))).items;
    expect(found?.internalCode).toBe('XLS-900001');
    expect(found?.identifiers.find((item) => item.type === 'LEGACY_CODE')).toMatchObject({
      value: 'PLACA-77123',
      origin: 'IMPORTED',
      validTo: null,
      current: true,
    });
  });

  it('encuentra un activo por su código visible', async () => {
    const id = await assetIdOf(900004);
    await dataSource.query(
      `INSERT INTO asset_identifier (asset_id, identifier_type, value, origin) VALUES ($1, 'VISIBLE_CODE', 'UNAC-004500-7', 'GENERATED')`,
      [id],
    );
    const page = await assets.list(query({ q: 'unac-0045' }));
    expect(page.items.map((item) => item.id)).toEqual([id]);
    expect(page.items[0]?.identifiers.map((item) => item.type).sort()).toEqual(['OPAQUE_ID', 'VISIBLE_CODE']);
    const detail = await assets.getById(id);
    expect(detail.identifiers.find((item) => item.type === 'VISIBLE_CODE')?.value).toBe('UNAC-004500-7');
  });

  it('no busca por el identificador opaco ni deja pasar comodines de LIKE', async () => {
    const id = await assetIdOf(900001);
    const [opaque] = (await dataSource.query(
      `SELECT value FROM asset_identifier WHERE asset_id = $1 AND identifier_type = 'OPAQUE_ID'`,
      [id],
    )) as Array<{ value: string }>;
    expect((await assets.list(query({ q: opaque?.value ?? '' }))).total).toBe(0);
    const wildcard = await assets.list(query({ q: '100%_' }));
    expect(wildcard.items.map((item) => item.internalCode)).toEqual(['XLS-900005']);
    expect((await assets.list(query({ q: '%' }))).total).toBe(1);
  });

  it('marca un activo TEMP y filtra por bandera con el conteo correcto', async () => {
    const temp = await assets.getById(await assetIdOf(900002));
    expect(temp.dataQualityFlags).toContain('BARCODE_TEMP');
    expect(temp.identifiers.find((item) => item.type === 'LEGACY_CODE')?.value).toBe('TEMP');

    const center = (await dataSource.query(`SELECT id FROM cost_center WHERE external_code = 'SRCH-1'`)) as Array<{
      id: string;
    }>;
    const costCenterId = center[0]?.id ?? '';
    const byFlag = (dataQualityFlags: string[]) => assets.list(query({ costCenterId, dataQualityFlags }));
    expect((await byFlag(['BARCODE_TEMP'])).total).toBe(2);
    expect((await byFlag(['BARCODE_EMPTY'])).items.map((item) => item.internalCode)).toEqual(['XLS-900004']);
    expect((await byFlag(['BARCODE_TEMP', 'ACQUISITION_DATE_MISSING'])).items.map((item) => item.internalCode)).toEqual([
      'XLS-900003',
    ]);
    expect((await assets.list(query({ costCenterId }))).total).toBe(5);
  });

  describe.runIf(existsSync(REAL_ASSETS) && existsSync(REAL_COST_CENTERS))('con los datos reales importados', () => {
    it('el filtro por bandera cuadra con la conciliación de la carga real', async () => {
      const flags = [
        ['BARCODE_TEMP'],
        ['BARCODE_DUPLICATED'],
        ['BARCODE_EMPTY'],
        ['ACQUISITION_DATE_MISSING'],
        ['PRICE_ZERO'],
        ['BARCODE_TEMP', 'ACQUISITION_DATE_MISSING'],
      ];
      const totals = async () =>
        Promise.all(flags.map(async (dataQualityFlags) => (await assets.list(query({ dataQualityFlags }))).total));
      const before = await totals();

      const centers = await imports.upload(readFileSync(REAL_COST_CENTERS), 'centros de costo.xlsx', actor.id);
      const centersPreview = await imports.preview(
        centers.batchId,
        { sheet: '2026', target: 'COST_CENTERS', mapping: { code: 'B', name: 'C' } },
        actor.id,
      );
      await imports.confirm(centersPreview.importId, actor.id);
      const result = await importAssets(readFileSync(REAL_ASSETS), 'ACTIVOS', {
        legacyAssetId: 'A',
        legacyCode: 'B',
        description: 'C',
        model: 'D',
        acquisitionDocument: 'E',
        serial: 'F',
        costCenterCode: 'H',
        acquisitionDate: 'I',
        usefulLifeYears: 'L',
        notes: 'N',
        acquisitionPrice: 'U',
      });
      expect(result.inserted).toBe(8780);

      const after = await totals();
      expect(after.map((total, index) => total - (before[index] ?? 0))).toEqual([3109, 546, 34, 1002, 526, 100]);

      const legacy = (await dataSource.query(
        `SELECT i.value, i.asset_id FROM asset_identifier i JOIN asset_import_origin o ON o.asset_id = i.asset_id
         WHERE i.identifier_type = 'LEGACY_CODE' AND i.value = '08252'`,
      )) as Array<{ value: string; asset_id: string }>;
      expect(legacy.length).toBeGreaterThan(0);
      const found = (await assets.list(query({ q: '08252' }))).items.map((item) => item.id);
      expect(found).toEqual(expect.arrayContaining(legacy.map((row) => row.asset_id)));
    }, 600_000);
  });
});
