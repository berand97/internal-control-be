// Endpoints de plantillas de importación por HTTP real: permiso de la importación, descarga xlsx con su nombre y
// metadatos envueltos; subir la plantilla devuelve la versión y el mapeo reconocido.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { createAppValidationPipe } from '../../src/common/pipes/app-validation.pipe.js';
import { TokenService } from '../../src/modules/auth/services/token.service.js';
import { templateVersion, XLSX_MIME } from '../../src/modules/staging/templates/import-template.js';
import { createActor, useSharedStorage } from './helpers.js';

const binary = (res: request.Response, done: (error: Error | null, body: Buffer) => void): void => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => done(null, Buffer.concat(chunks)));
};

describe('Plantillas de importación por HTTP (HTTP real + PostgreSQL real)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  const tokens: Record<string, string> = {};
  const http = () => request(app.getHttpServer());
  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who] ?? ''}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
    dataSource = app.get(DataSource);
    await useSharedStorage(dataSource);
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
      tokens[name] = app.get(TokenService).signAccessToken({ ...user, sessionId: randomUUID() });
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('metadatos y descarga con el permiso de la importación; sin permiso, 403', async () => {
    const list = await http().get('/api/v1/imports/templates').set(auth('director')).expect(200);
    expect(list.body.type).toBe('SUCCESS');
    expect(list.body.data.map((item: { target: string; version: string }) => [item.target, item.version])).toEqual([
      ['ASSETS', templateVersion('ASSETS')],
      ['COST_CENTERS', templateVersion('COST_CENTERS')],
      ['PERSONS', templateVersion('PERSONS')],
    ]);
    expect(list.body.data[2]).toEqual(
      expect.objectContaining({
        fileName: `plantilla-personas-v${templateVersion('PERSONS')}.xlsx`,
        generatedAt: expect.any(String),
        versionSince: expect.any(String),
        catalogCounts: expect.objectContaining({ DOCUMENT_TYPES: 6 }),
      }),
    );

    const file = await http().get('/api/v1/imports/templates/PERSONS').set(auth('director')).buffer(true).parse(binary).expect(200);
    expect(file.headers['content-type']).toContain(XLSX_MIME);
    expect(file.headers['content-disposition']).toBe(
      `attachment; filename="plantilla-personas-v${templateVersion('PERSONS')}.xlsx"`,
    );
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.body as ArrayBuffer);
    expect(workbook.worksheets[0]?.name).toBe('Personas');

    await http().get('/api/v1/imports/templates/OTRO').set(auth('director')).expect(400);
    await http().get('/api/v1/imports/templates').set(auth('nobody')).expect(403);
    await http().get('/api/v1/imports/templates/ASSETS').set(auth('nobody')).expect(403);
    await http().get('/api/v1/imports/templates').expect(401);

    const upload = await http()
      .post('/api/v1/imports')
      .set(auth('director'))
      .attach('file', file.body as Buffer, 'plantilla.xlsx')
      .expect(201);
    expect(upload.body.data.template).toMatchObject({
      target: 'PERSONS',
      version: templateVersion('PERSONS'),
      outdated: false,
      mapping: expect.objectContaining({ documentNumber: 'A', documentType: 'B', email: 'F' }),
    });

    const fields = await http().get('/api/v1/imports/targets/PERSONS/fields').set(auth('director')).expect(200);
    expect(fields.body.data.fields.find((item: { field: string }) => item.field === 'email')).toMatchObject({
      header: 'Correo institucional',
      whenEmpty: 'QUARANTINE',
      inTemplate: true,
    });
    expect(fields.body.data.rules).toHaveLength(4);
  });
});
