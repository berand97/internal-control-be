import type { Type } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import ExcelJS from 'exceljs';
import { readFile } from 'node:fs/promises';
import { DataSource } from 'typeorm';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';
import { AppConfigModule } from '../../src/config/config.module.js';
import dataSourceConfig from '../../src/database/data-source.js';
import { DatabaseModule } from '../../src/database/database.module.js';
import { AssetsModule } from '../../src/modules/assets/assets.module.js';
import { MovementType } from '../../src/modules/assets/enums/movement-type.enum.js';
import { OperationalStatus } from '../../src/modules/assets/enums/operational-status.enum.js';
import { AssetStateService } from '../../src/modules/assets/services/asset-state.service.js';
import { AssetTimelineService } from '../../src/modules/assets/services/asset-timeline.service.js';
import { GLOBAL_COST_CENTER_SCOPE } from '../../src/modules/roles/services/cost-center-scope.js';
import { DocumentsModule } from '../../src/modules/documents/documents.module.js';
import { PDF_CONVERTER, type PdfConverter } from '../../src/modules/documents/pdf/pdf-converter.js';
import { DocumentEngineService } from '../../src/modules/documents/services/document-engine.service.js';
import { FeaturesModule } from '../../src/modules/features/features.module.js';
import { ExcelImportService } from '../../src/modules/staging/services/excel-import.service.js';
import { StagingModule } from '../../src/modules/staging/staging.module.js';
import { StorageModule } from '../../src/shared/storage/storage.module.js';
import { createActor, scalar, useSharedStorage } from './helpers.js';

const TEMPLATE = 'templates/formats/OCI-01-55-v2.docx';

class FakePdfConverter implements PdfConverter {
  toPdf(docx: Buffer): Promise<Buffer> {
    return Promise.resolve(Buffer.concat([Buffer.from('%PDF-1.7 simulado\n'), docx.subarray(0, 16)]));
  }
}

describe('Historia del activo (PostgreSQL real)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let timeline: AssetTimelineService;
  let engine: DocumentEngineService;
  let state: AssetStateService;
  let director: AuthenticatedUser;
  let costCenters: { from: string; to: string };
  let personId: string;

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
      .useValue(new FakePdfConverter())
      .compile();
    await moduleRef.init();
    dataSource = moduleRef.get(DataSource);
    timeline = moduleRef.get(AssetTimelineService);
    engine = moduleRef.get(DocumentEngineService);
    state = moduleRef.get(AssetStateService);
    await useSharedStorage(dataSource);

    director = await createActor(dataSource);
    await dataSource.query(
      `INSERT INTO user_role (user_id, role_id, scope_type) SELECT $1, id, 'GLOBAL' FROM role WHERE code = 'INTERNAL_CONTROL_DIRECTOR'`,
      [director.id],
    );
    costCenters = {
      from: await scalar<string>(dataSource, `INSERT INTO cost_center (external_code, name) VALUES ('TL-1', 'Bodega') RETURNING id`),
      to: await scalar<string>(dataSource, `INSERT INTO cost_center (external_code, name) VALUES ('TL-2', 'Laboratorio') RETURNING id`),
    };
    personId = await scalar<string>(
      dataSource,
      `INSERT INTO person (first_name, last_name, email, document_type, document_number)
       VALUES ('Responsable', 'Historia', 'responsable.historia@unac.edu.co', 'CC', '1000000077') RETURNING id`,
    );
    const template = await readFile(TEMPLATE);
    for (const formatKey of ['OCI-17-90-INFORME']) {
      await engine.uploadTemplate(
        formatKey,
        { buffer: template, originalname: 'plantilla.docx' },
        { sgcVersion: '1', effectiveDate: '2026-01-01' },
        director.id,
      );
    }
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  const newAsset = async (): Promise<string> => {
    const categoryId = await scalar<string>(
      dataSource,
      `INSERT INTO asset_category (code, name, requires_photo) VALUES ('TL-' || substr(md5(random()::text), 1, 8), 'Historia', FALSE) RETURNING id`,
    );
    const id = await scalar<string>(
      dataSource,
      `INSERT INTO asset (internal_code, description, category_id, acquisition_type_id, acquisition_date, acquisition_document,
         current_cost_center_id, created_by, physical_condition)
       VALUES ('TL-' || substr(md5(random()::text), 1, 10), 'Microscopio binocular', $1,
         (SELECT id FROM acquisition_type WHERE code = 'PURCHASE'), '2019-05-10', 'FV-1234', $2, $3, 'GOOD')
       RETURNING id`,
      [categoryId, costCenters.from, director.id],
    );
    await state.apply({
      assetId: id,
      actorId: director.id,
      patch: {},
      movement: { type: MovementType.Registration, initial: true, reason: 'Alta', documentReference: null, executedAt: new Date('2020-01-15T15:00:00Z') },
    });
    return id;
  };

  it('devuelve movimientos y documentos en orden, con el documento descargable como PDF', async () => {
    const assetId = await newAsset();
    const transfer = await state.apply({
      assetId,
      actorId: director.id,
      patch: { costCenterId: costCenters.to },
      movement: { type: MovementType.Transfer, reason: 'Traslado al laboratorio', documentReference: null, executedAt: new Date('2021-03-01T14:00:00Z') },
    });
    expect(transfer.costCenterId).toBe(costCenters.to);
    const transferMovementId = await scalar<string>(
      dataSource,
      `SELECT id FROM asset_movement WHERE asset_id = $1 AND movement_type = 'TRANSFER'`,
      [assetId],
    );
    const linked = await engine.generate(
      {
        formatKey: 'OCI-17-90-INFORME',
        costCenterId: costCenters.to,
        responsiblePersonId: personId,
        assetIds: [assetId],
        movementIds: { [assetId]: transferMovementId },
        signers: { AUDITA: personId },
      },
      director.id,
    );
    const standalone = await engine.generate(
      { formatKey: 'OCI-17-90-INFORME', costCenterId: costCenters.to, assetIds: [assetId], signers: { AUDITA: personId } },
      director.id,
    );
    await state.apply({
      assetId,
      actorId: director.id,
      patch: { operationalStatus: OperationalStatus.InMaintenance },
      movement: { type: MovementType.MaintenanceIn, reason: 'Calibración', documentReference: null },
    });

    const page = await timeline.timeline(assetId, { page: 1, pageSize: 50, order: 'asc' }, GLOBAL_COST_CENTER_SCOPE);
    expect(page.total).toBe(5);
    expect(page.items.map((item) => [item.kind, item.type])).toEqual([
      ['ASSET', 'ACQUISITION'],
      ['MOVEMENT', 'REGISTRATION'],
      ['MOVEMENT', 'TRANSFER'],
      ['DOCUMENT', 'OCI-17-90-INFORME'],
      ['MOVEMENT', 'MAINTENANCE_IN'],
    ]);
    const occurred = page.items.map((item) => item.occurredAt);
    expect([...occurred].sort()).toEqual(occurred);

    const [acquisition, registration, transferEvent, documentEvent, maintenance] = page.items;
    expect(acquisition).toMatchObject({ summary: 'Compra (FV-1234)', datePrecision: 'DAY', documentId: null, actor: null });
    expect(acquisition?.occurredAt).toBe('2019-05-10T00:00:00.000Z');
    expect(registration).toMatchObject({ datePrecision: 'INSTANT', actor: { userId: director.id } });
    expect(transferEvent).toMatchObject({
      summary: 'Traslado de centro de costo: TL-1 Bodega → TL-2 Laboratorio',
      documentId: linked.id,
      document: { id: linked.id, formatKey: 'OCI-17-90-INFORME', number: linked.number, status: 'PENDING_SIGNATURE' },
    });
    expect(documentEvent).toMatchObject({
      documentId: standalone.id,
      summary: `Informe de baja a la Vicerrectoría Financiera ${standalone.number}`,
    });
    expect(maintenance?.documentId).toBeNull();

    for (const documentId of [transferEvent?.documentId, documentEvent?.documentId]) {
      const file = await engine.download(documentId ?? '', 'pdf', director.id);
      expect(file.contentType).toBe('application/pdf');
      expect(file.body.subarray(0, 5).toString()).toBe('%PDF-');
    }

    const newestFirst = await timeline.timeline(assetId, { page: 1, pageSize: 2, order: 'desc' }, GLOBAL_COST_CENTER_SCOPE);
    expect(newestFirst).toMatchObject({ total: 5, hasNext: true });
    expect(newestFirst.items.map((item) => item.type)).toEqual(['MAINTENANCE_IN', 'OCI-17-90-INFORME']);
    const second = await timeline.timeline(assetId, { page: 2, pageSize: 2, order: 'desc' }, GLOBAL_COST_CENTER_SCOPE);
    expect(second.items.map((item) => item.type)).toEqual(['TRANSFER', 'REGISTRATION']);
  });

  it('rechaza enlazar un movimiento que no es del activo, sin consumir consecutivo', async () => {
    const assetId = await newAsset();
    const otherMovement = await scalar<string>(
      dataSource,
      `SELECT id FROM asset_movement WHERE asset_id <> $1 LIMIT 1`,
      [assetId],
    );
    const before = await scalar<string>(dataSource, `SELECT current_value FROM document_sequence WHERE format_key = 'OCI-17-90-INFORME'`);
    await expect(
      engine.generate(
        { formatKey: 'OCI-17-90-INFORME', assetIds: [assetId], movementIds: { [assetId]: otherMovement }, signers: { AUDITA: personId } },
        director.id,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await scalar<string>(dataSource, `SELECT current_value FROM document_sequence WHERE format_key = 'OCI-17-90-INFORME'`)).toBe(before);
  });

  it('un activo importado muestra solo su registro, con la precisión de fecha que tiene', async () => {
    const imports = moduleRef.get(ExcelImportService);
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Hist');
    [
      ['Id', 'Codigo', 'Descripcion', 'Centro', 'Fecha compra'],
      [910001, 'H-001', 'Con fecha', 'TL-1', new Date('2018-02-03')],
      [910002, 'H-002', 'Sin fecha', 'TL-1', null],
    ].forEach((values, index) => {
      const row = sheet.getRow(index + 1);
      values.forEach((value, column) => {
        if (value !== null) {
          row.getCell(column + 1).value = value;
        }
      });
      row.commit();
    });
    const upload = await imports.upload(Buffer.from(await book.xlsx.writeBuffer()), 'historia.xlsx', director.id);
    const preview = await imports.preview(
      upload.batchId,
      {
        sheet: 'Hist',
        target: 'ASSETS',
        mapping: { legacyAssetId: 'A', legacyCode: 'B', description: 'C', costCenterCode: 'D', acquisitionDate: 'E' },
      },
      director.id,
    );
    await imports.confirm(preview.importId, director.id);
    const idOf = (legacy: number) =>
      scalar<string>(dataSource, 'SELECT asset_id FROM asset_import_origin WHERE legacy_asset_id = $1', [String(legacy)]);

    const dated = await timeline.timeline(await idOf(910001), { page: 1, pageSize: 50, order: 'asc' }, GLOBAL_COST_CENTER_SCOPE);
    expect(dated.items.map((item) => [item.kind, item.type, item.datePrecision, item.occurredAt.slice(0, 10)])).toEqual([
      ['ASSET', 'ACQUISITION', 'DAY', '2018-02-03'],
      ['MOVEMENT', 'REGISTRATION', 'DAY', '2018-02-03'],
    ]);
    expect(dated.items[1]).toMatchObject({
      summary: 'Registro por importación del inventario en Excel',
      documentId: null,
      actor: { userId: director.id },
    });

    const undated = await timeline.timeline(await idOf(910002), { page: 1, pageSize: 50, order: 'asc' }, GLOBAL_COST_CENTER_SCOPE);
    expect(undated.total).toBe(1);
    expect(undated.items[0]).toMatchObject({
      kind: 'MOVEMENT',
      type: 'REGISTRATION',
      datePrecision: 'UNKNOWN',
      summary: 'Registro por importación del inventario en Excel (sin fecha de compra)',
    });
  });

  it('responde 404 para un activo que no existe', async () => {
    await expect(
      timeline.timeline('00000000-0000-4000-8000-000000000000', { page: 1, pageSize: 10, order: 'asc' }, GLOBAL_COST_CENTER_SCOPE),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });
});
