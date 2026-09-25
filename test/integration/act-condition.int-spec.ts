import type { Type } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import ExcelJS from 'exceljs';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import PizZip from 'pizzip';
import { DataSource } from 'typeorm';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';
import { AppConfigModule } from '../../src/config/config.module.js';
import dataSourceConfig from '../../src/database/data-source.js';
import { DatabaseModule } from '../../src/database/database.module.js';
import { AssetsModule } from '../../src/modules/assets/assets.module.js';
import { MovementType } from '../../src/modules/assets/enums/movement-type.enum.js';
import { PhysicalCondition } from '../../src/modules/assets/enums/physical-condition.enum.js';
import { AssetStateService } from '../../src/modules/assets/services/asset-state.service.js';
import { DocumentsModule } from '../../src/modules/documents/documents.module.js';
import { PDF_CONVERTER, type PdfConverter } from '../../src/modules/documents/pdf/pdf-converter.js';
import { DocumentEngineService } from '../../src/modules/documents/services/document-engine.service.js';
import { FeaturesModule } from '../../src/modules/features/features.module.js';
import { ExcelImportService } from '../../src/modules/staging/services/excel-import.service.js';
import { StagingModule } from '../../src/modules/staging/staging.module.js';
import { StorageModule } from '../../src/shared/storage/storage.module.js';
import { createActor, scalar, useSharedStorage } from './helpers.js';

const TEMPLATE = 'templates/formats/OCI-01-55-v2.docx';
const FORMAT = 'OCI-17-90-INFORME';

class BlankPdfConverter implements PdfConverter {
  async toPdf(): Promise<Buffer> {
    const pdf = await PDFDocument.create();
    pdf.addPage([612, 792]);
    return Buffer.from(await pdf.save());
  }
}

const assetRows = (docx: Buffer): string[][] => {
  const xml = new PizZip(docx).file('word/document.xml')?.asText() ?? '';
  const table = [...xml.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>/g)].map((match) => match[0]).find((item) => item.includes('DESCRIPCI'));
  return [...(table ?? '').matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)]
    .slice(1)
    .map((row) =>
      [...row[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((cell) =>
        [...cell[0].matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((text) => text[1]).join('').trim(),
      ),
    );
};

describe('El acta no afirma un estado físico que nadie verificó (PostgreSQL real)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let engine: DocumentEngineService;
  let state: AssetStateService;
  let director: AuthenticatedUser;
  let auditorId: string;

  const idOf = (legacy: number) =>
    scalar<string>(dataSource, 'SELECT asset_id FROM asset_import_origin WHERE legacy_asset_id = $1', [String(legacy)]);

  const actRows = async (assetIds: string[]) => {
    const document = await engine.generate({ formatKey: FORMAT, assetIds, signers: { AUDITA: auditorId } }, director.id);
    return assetRows((await engine.download(document.id, 'docx', director.id)).body);
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule,
        DatabaseModule,
        TypeOrmModule.forFeature([...(dataSourceConfig.options.entities as Type<unknown>[])]),
        FeaturesModule,
        StorageModule,
        DocumentsModule,
        AssetsModule,
        StagingModule,
      ],
    })
      .overrideProvider(PDF_CONVERTER)
      .useValue(new BlankPdfConverter())
      .compile();
    await moduleRef.init();
    dataSource = moduleRef.get(DataSource);
    engine = moduleRef.get(DocumentEngineService);
    state = moduleRef.get(AssetStateService);
    await useSharedStorage(dataSource);
    director = await createActor(dataSource);
    await dataSource.query(
      `INSERT INTO user_role (user_id, role_id, scope_type) SELECT $1, id, 'GLOBAL' FROM role WHERE code = 'INTERNAL_CONTROL_DIRECTOR'`,
      [director.id],
    );
    auditorId = director.personId;
    await engine.uploadTemplate(
      FORMAT,
      { buffer: await readFile(TEMPLATE), originalname: 'plantilla.docx' },
      { sgcVersion: '1', effectiveDate: '2026-04-01' },
      director.id,
    );

    const imports = moduleRef.get(ExcelImportService);
    const book = new ExcelJS.Workbook();
    const centers = book.addWorksheet('Centros');
    [['Codigo', 'Nombre'], ['EST-1', 'Centro estado']].forEach((values, index) => {
      centers.getRow(index + 1).values = values;
    });
    const sheet = book.addWorksheet('Activos');
    [
      ['Id', 'Codigo', 'Descripcion', 'Centro', 'Fecha'],
      [920001, 'EST-001', 'Silla importada', 'EST-1', new Date('2019-01-01')],
      [920002, 'EST-002', 'Mesa importada', 'EST-1', new Date('2019-01-01')],
    ].forEach((values, index) => {
      sheet.getRow(index + 1).values = values;
    });
    const upload = await imports.upload(Buffer.from(await book.xlsx.writeBuffer()), 'estado.xlsx', director.id);
    const centersPreview = await imports.preview(upload.batchId, { sheet: 'Centros', target: 'COST_CENTERS', mapping: { code: 'A', name: 'B' } }, director.id);
    await imports.confirm(centersPreview.importId, director.id);
    const assetsPreview = await imports.preview(
      upload.batchId,
      { sheet: 'Activos', target: 'ASSETS', mapping: { legacyAssetId: 'A', legacyCode: 'B', description: 'C', costCenterCode: 'D', acquisitionDate: 'E' } },
      director.id,
    );
    await imports.confirm(assetsPreview.importId, director.id);
  }, 120_000);

  afterAll(async () => {
    await moduleRef.close();
  });

  it('la importación ya no guarda un estado que nadie revisó', async () => {
    const [row] = (await dataSource.query('SELECT physical_condition, data_quality_flags FROM asset WHERE id = $1', [await idOf(920001)])) as Array<{
      physical_condition: string | null;
      data_quality_flags: string[];
    }>;
    expect(row).toEqual({ physical_condition: null, data_quality_flags: expect.arrayContaining(['PHYSICAL_CONDITION_UNKNOWN']) });
  });

  it('el acta imprime "Sin verificar" para un activo importado, y el estado real cuando alguien lo verificó', async () => {
    const unverified = await idOf(920001);
    const verified = await idOf(920002);
    await state.apply({
      assetId: verified,
      actorId: director.id,
      patch: { physicalCondition: PhysicalCondition.Fair },
      movement: { type: MovementType.ConditionChange, reason: 'Revisión en sitio', documentReference: null },
    });
    const [flags] = (await dataSource.query('SELECT data_quality_flags FROM asset WHERE id = $1', [verified])) as Array<{
      data_quality_flags: string[];
    }>;
    expect(flags?.data_quality_flags).not.toContain('PHYSICAL_CONDITION_UNKNOWN');

    const rows = await actRows([unverified, verified]);
    expect(rows.map((cells) => [cells[3], cells.at(-1)])).toEqual([
      ['Silla importada', 'Sin verificar'],
      ['Mesa importada', 'Regular'],
    ]);
  });

  it('un activo cargado antes del cambio (GOOD con la bandera) tampoco sale como "Bueno"', async () => {
    const legacy = await idOf(920001);
    await dataSource.query(`UPDATE asset SET physical_condition = 'GOOD' WHERE id = $1`, [legacy]);
    const rows = await actRows([legacy]);
    expect(rows[0]?.at(-1)).toBe('Sin verificar');
    expect(rows.flat()).not.toContain('Bueno');
  });
});
