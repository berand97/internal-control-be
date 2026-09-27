// La importación dice lo que va a hacer antes de escribir (HTTP real + PostgreSQL real): muestra de filas al subir
// (acotada y sin rastro en audit_log ni en staging_import), resumen llano por campo, bloqueo cuando un campo sin
// columna rechazaría el 100 % de las filas, y la vista previa cuenta cada recorte, vida útil descartada y
// categoría/condición vacías que el INSERT aplica: lo contado es exactamente lo que queda en el modelo.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { createAppValidationPipe } from '../../src/common/pipes/app-validation.pipe.js';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';
import { TokenService } from '../../src/modules/auth/services/token.service.js';
import { SAMPLE_CELL_MAX, SAMPLE_ROWS } from '../../src/modules/staging/import/import-fields.js';
import { ExcelImportService } from '../../src/modules/staging/services/excel-import.service.js';
import { ImportJobsService } from '../../src/modules/staging/services/import-jobs.service.js';
import { DATA_SHEET_NAME } from '../../src/modules/staging/templates/import-template.js';
import { ImportTemplateService } from '../../src/modules/staging/templates/import-template.service.js';
import { createActor, openTestSession, scalar, useSharedStorage } from './helpers.js';

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

const ERROR_CODE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;

describe('La importación dice la verdad antes de escribir (HTTP real + PostgreSQL real)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let imports: ExcelImportService;
  let actor: AuthenticatedUser;
  const tokens: Record<string, string> = {};
  const http = () => request(app.getHttpServer());
  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who] ?? ''}` });
  const tag = () => randomUUID().replace(/-/g, '').slice(0, 8);
  const count = (sql: string, params: unknown[] = []) => scalar<string>(dataSource, sql, params).then(Number);
  let center: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
    dataSource = app.get(DataSource);
    imports = app.get(ExcelImportService);
    await useSharedStorage(dataSource);
    actor = await createActor(dataSource);
    for (const [name, role] of [
      ['director', 'INTERNAL_CONTROL_DIRECTOR'],
      ['nobody', null],
    ] as const) {
      const user = await createActor(dataSource);
      if (role) {
        await dataSource.query(
          `INSERT INTO user_role (user_id, role_id, scope_type) SELECT $1, id, 'GLOBAL' FROM role WHERE code = $2`,
          [user.id, role],
        );
      }
      tokens[name] = app.get(TokenService).signAccessToken({ ...user, sessionId: await openTestSession(dataSource, user.id) });
    }
    center = `TR${tag().slice(0, 6)}`;
    await dataSource.query(`INSERT INTO cost_center (external_code, name) VALUES ($1, 'Centro de la prueba')`, [center]);
    await dataSource.query(
      `INSERT INTO asset_category (code, name) VALUES ('TRUTH_CAT', 'Categoría de la prueba') ON CONFLICT (code) DO NOTHING`,
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('cada campo trae un resumen llano, sin códigos, con el permiso de la importación', async () => {
    for (const target of ['ASSETS', 'COST_CENTERS', 'PERSONS']) {
      const res = await http().get(`/api/v1/imports/targets/${target}/fields`).set(auth('director')).expect(200);
      const fields = res.body.data.fields as Array<{ field: string; summary: string }>;
      expect(fields.length).toBeGreaterThan(0);
      for (const field of fields) {
        expect(field.summary.trim()).not.toBe('');
        expect(field.summary).not.toMatch(ERROR_CODE);
      }
    }
    const persons = await http().get('/api/v1/imports/targets/PERSONS/fields').set(auth('director')).expect(200);
    const summaryOf = (field: string) =>
      (persons.body.data.fields as Array<{ field: string; summary: string }>).find((item) => item.field === field)?.summary;
    expect(summaryOf('email')).toBe('El correo debe terminar en @unac.edu.co.');
    expect(summaryOf('documentNumber')).toBe('Con CC o TI, solo dígitos. No puede repetirse en el archivo.');
    expect(summaryOf('documentType')).toBe('Un tipo de la lista (CC, CE, PA, PEP, PPT, TI) o su abreviatura.');
    await http().get('/api/v1/imports/targets/PERSONS/fields').set(auth('nobody')).expect(403);
  });

  it('POST /imports trae hasta 3 filas de muestra recortadas y no deja rastro en audit_log ni en staging_import', async () => {
    const secret = `Nombre${tag()}`;
    const long = `${secret}${'x'.repeat(100)}`;
    const file = await workbook('Personas', {
      1: ['LISTADO DE FUNCIONARIOS'],
      2: ['Documento', 'Nombres', 'Correo'],
      3: ['1001', long, 'uno@unac.edu.co', 'sin encabezado'],
      5: ['1002', 'DOS', 'dos@unac.edu.co'],
      6: ['1003', 'TRES', 'tres@unac.edu.co'],
      7: ['1004', 'CUATRO', 'cuatro@unac.edu.co'],
    });
    const auditBefore = await count('SELECT count(*) FROM audit_log');
    const importsBefore = await count('SELECT count(*) FROM staging_import');
    const res = await http().post('/api/v1/imports').set(auth('director')).attach('file', file, 'muestra.xlsx').expect(201);
    const sheet = res.body.data.sheets[0] as {
      detectedHeaderRow: number;
      sampleRows: Array<{ rowNumber: number; cells: Record<string, string> }>;
    };
    expect(sheet.detectedHeaderRow).toBe(2);
    expect(sheet.sampleRows).toHaveLength(SAMPLE_ROWS);
    // La fila 4 no existe (vacía): la muestra son las primeras con datos.
    expect(sheet.sampleRows.map((row) => row.rowNumber)).toEqual([3, 5, 6]);
    const first = sheet.sampleRows[0]?.cells ?? {};
    expect(Object.keys(first).sort()).toEqual(['A', 'B', 'C']);
    expect(first['A']).toBe('1001');
    expect(first['B']).toHaveLength(SAMPLE_CELL_MAX);
    expect(first['B']?.endsWith('…')).toBe(true);
    expect(first['B']?.startsWith(secret)).toBe(true);

    // Nada de la muestra se guarda ni se audita: subir no escribe audit_log ni una importación.
    expect(await count('SELECT count(*) FROM audit_log')).toBe(auditBefore);
    expect(await count('SELECT count(*) FROM staging_import')).toBe(importsBefore);
    expect(await count('SELECT count(*) FROM audit_log WHERE changes::text LIKE $1', [`%${secret}%`])).toBe(0);

    await http().post('/api/v1/imports').set(auth('nobody')).attach('file', file, 'muestra.xlsx').expect(403);
  });

  it('plantilla: la muestra salta la fila de ejemplo', async () => {
    const download = await app.get(ImportTemplateService).download('COST_CENTERS', actor.id);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(download.body as unknown as ArrayBuffer);
    const sheet = book.getWorksheet(DATA_SHEET_NAME.COST_CENTERS);
    const row = sheet?.getRow(3);
    if (row) {
      row.getCell(1).value = `MU${tag().slice(0, 5)}`;
      row.getCell(2).value = 'Centro real';
      row.commit();
    }
    const upload = await imports.upload(Buffer.from(await book.xlsx.writeBuffer()), 'centros-plantilla.xlsx', actor.id);
    const data = upload.sheets.find((item) => item.name === DATA_SHEET_NAME.COST_CENTERS);
    expect(upload.template).not.toBeNull();
    expect(data?.sampleRows.map((item) => item.rowNumber)).toEqual([3]);
    expect(data?.sampleRows[0]?.cells['B']).toBe('Centro real');
  });

  it('personas sin columna de correo: la vista previa bloquea y dice qué hacer; con la columna, pasa', async () => {
    const file = await workbook('Personas', {
      1: ['Documento', 'Nombres', 'Apellidos', 'Correo'],
      2: [`9${tag().replace(/\D/g, '1').slice(0, 7)}`, 'ANA', 'RÍOS', `ana.${tag()}@unac.edu.co`],
    });
    const upload = await http().post('/api/v1/imports').set(auth('director')).attach('file', file, 'sin-correo.xlsx').expect(201);
    const batchId = upload.body.data.batchId as string;
    const base = { sheet: 'Personas', target: 'PERSONS', documentType: 'CC' };
    const blocked = await http()
      .post(`/api/v1/imports/${batchId}/previews`)
      .set(auth('director'))
      .send({ ...base, mapping: { documentNumber: 'A', firstName: 'B', lastName: 'C' } })
      .expect(400);
    expect(blocked.body.error.code).toBe('VALIDATION_FAILED');
    expect(blocked.body.error.details).toEqual([
      {
        field: 'email',
        message:
          'Asigne la columna de «Correo institucional»: sin ese dato ninguna fila se importa. Si el archivo no la trae, agréguela y vuelva a subirlo.',
      },
    ]);
    expect(blocked.body.error.details[0].message).not.toMatch(ERROR_CODE);
    const ok = await http()
      .post(`/api/v1/imports/${batchId}/previews`)
      .set(auth('director'))
      .send({ ...base, mapping: { documentNumber: 'A', firstName: 'B', lastName: 'C', email: 'D' } })
      .expect(200);
    expect(ok.body.data.summary).toMatchObject({ rowsRead: 1, toInsert: 1, transformations: [] });
  });

  it('activos: la vista previa cuenta recortes, vida útil descartada y categoría/condición vacías, y el INSERT hace exactamente eso', async () => {
    const t = tag();
    const id = (n: number) => `TR${t}${n}`;
    const file = await workbook('Activos', {
      1: ['Id', 'Codigo', 'Descripcion', 'Centro', 'Modelo', 'Serie', 'Documento', 'Vida util', 'Categoria', 'Condicion'],
      2: [id(1), 'B'.repeat(55), 'D'.repeat(600), center, 'M'.repeat(151), 'S'.repeat(100), 'F-1', 5, 'TRUTH_CAT', 'GOOD'],
      3: [id(2), 'X-2', 'Silla', center, null, null, 'F'.repeat(101), 5.5, null, null],
      4: [id(3), 'X-3', 'Mesa', center, null, null, null, 'cinco', 'TRUTH_CAT', null],
      5: [id(4), 'X-4', 'Archivador', center, null, null, null, 7, null, 'FAIR'],
      // Centro inexistente: va a cuarentena, no se importa, así que su recorte y su vida útil no se cuentan.
      6: [id(5), 'X-5', 'D'.repeat(700), 'NO-EXISTE-TR', null, null, null, 'nunca', null, null],
    });
    const upload = await imports.upload(file, 'activos-verdad.xlsx', actor.id);
    const mapping = {
      legacyAssetId: 'A',
      legacyCode: 'B',
      description: 'C',
      costCenterCode: 'D',
      model: 'E',
      serial: 'F',
      acquisitionDocument: 'G',
      usefulLifeYears: 'H',
      categoryCode: 'I',
      physicalCondition: 'J',
    };
    const preview = await imports.preview(upload.batchId, { sheet: 'Activos', target: 'ASSETS', mapping }, actor.id);
    expect(preview.summary).toMatchObject({
      rowsRead: 5,
      toInsert: 4,
      quarantined: { COST_CENTER_UNKNOWN: 1 },
      flagged: expect.objectContaining({ CATEGORY_UNASSIGNED: 2, PHYSICAL_CONDITION_UNKNOWN: 2 }),
    });
    expect(preview.summary.transformations).toHaveLength(5);
    expect(preview.summary.transformations).toEqual(
      expect.arrayContaining([
        { code: 'VALUE_TRUNCATED', field: 'legacyCode', label: 'Código de barras o código anterior', rows: 1, limit: 50 },
        { code: 'VALUE_TRUNCATED', field: 'description', label: 'Descripción', rows: 1, limit: 500 },
        { code: 'VALUE_TRUNCATED', field: 'model', label: 'Modelo', rows: 1, limit: 150 },
        { code: 'VALUE_TRUNCATED', field: 'acquisitionDocument', label: 'Documento de adquisición', rows: 1, limit: 100 },
        { code: 'USEFUL_LIFE_DISCARDED', field: 'usefulLifeYears', label: 'Vida útil (años)', rows: 2, limit: null },
      ]),
    );
    const issues = (await imports.issues(preview.importId, 1, 200)).items;
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rowNumber: 2,
          code: 'VALUE_TRUNCATED',
          column: 'Descripcion',
          rawValue: null,
          detail: 'Descripción: 600 caracteres; se guardan los primeros 500',
        }),
        expect.objectContaining({ rowNumber: 3, code: 'VALUE_TRUNCATED', column: 'Documento' }),
        expect.objectContaining({ rowNumber: 3, code: 'USEFUL_LIFE_DISCARDED', column: 'Vida util', rawValue: '5.5' }),
        expect.objectContaining({ rowNumber: 4, code: 'USEFUL_LIFE_DISCARDED', rawValue: 'cinco' }),
      ]),
    );
    expect(issues.filter((issue) => issue.rowNumber === 6 && issue.code !== 'COST_CENTER_UNKNOWN')).toEqual([]);
    expect(preview.summary.issues).toBe((await imports.issues(preview.importId, 1, 1000)).total);

    await app.get(ImportJobsService).runNow(preview.importId, actor.id);
    const imported = `SELECT a.* FROM asset a JOIN asset_import_origin o ON o.asset_id = a.id WHERE o.import_id = $1`;
    const model = async (condition: string) =>
      count(`SELECT count(*) FROM (${imported}) a WHERE ${condition}`, [preview.importId]);
    expect(await model('true')).toBe(4);
    // Lo que la vista previa contó es lo que quedó en el modelo.
    expect(await model('length(a.barcode) = 50')).toBe(1);
    expect(await model('length(a.description) = 500')).toBe(1);
    expect(await model('length(a.model) = 150')).toBe(1);
    expect(await model('length(a.serial_number) = 100')).toBe(1);
    expect(await model('length(a.acquisition_document) = 100')).toBe(1);
    expect(await model('a.useful_life_years IS NULL')).toBe(2);
    expect(await model(`a.useful_life_years = 7`)).toBe(1);
    expect(await model(`'CATEGORY_UNASSIGNED' = ANY(a.data_quality_flags)`)).toBe(2);
    expect(await model(`'PHYSICAL_CONDITION_UNKNOWN' = ANY(a.data_quality_flags)`)).toBe(2);
  });

  it('centros de costo: un nombre largo se cuenta como recortado y se guarda recortado', async () => {
    const code = `TC${tag().slice(0, 6)}`;
    const file = await workbook('Centros', { 1: ['Codigo', 'Nombre'], 2: [code, 'N'.repeat(250)], 3: [`${code}B`, 'Corto'] });
    const upload = await imports.upload(file, 'centros-largos.xlsx', actor.id);
    const preview = await imports.preview(
      upload.batchId,
      { sheet: 'Centros', target: 'COST_CENTERS', mapping: { code: 'A', name: 'B' } },
      actor.id,
    );
    expect(preview.summary.transformations).toEqual([
      { code: 'VALUE_TRUNCATED', field: 'name', label: 'Nombre', rows: 1, limit: 200 },
    ]);
    await app.get(ImportJobsService).runNow(preview.importId, actor.id);
    expect(await count('SELECT length(name) FROM cost_center WHERE external_code = $1', [code])).toBe(200);
  });
});
