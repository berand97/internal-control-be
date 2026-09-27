// Hallazgos de la auditoría de seguridad BE-01, BE-05 y BE-06 con HTTP real y PostgreSQL real:
// - BE-01: la carpeta del almacenamiento local no se cambia por API, la fila de BD se ignora y ninguna clave sale de ella.
// - BE-05: cada carga multipart tiene tope de tamaño y de archivos; un Excel "bomba" se rechaza antes de inflarse.
// - BE-06: un correo con salto de línea no entra por la importación ni por la base, y fromName no admite CR/LF.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { createAppValidationPipe } from '../../src/common/pipes/app-validation.pipe.js';
import { TokenService } from '../../src/modules/auth/services/token.service.js';
import { ExcelImportService } from '../../src/modules/staging/services/excel-import.service.js';
import { ImportJobsService } from '../../src/modules/staging/services/import-jobs.service.js';
import { UPLOAD_LIMITS } from '../../src/shared/storage/uploads/bounded-file.interceptor.js';
import { createActor, scalar, SHARED_STORAGE_DIR, useSharedStorage } from './helpers.js';

describe('Endurecimiento BE-01 / BE-05 / BE-06 (HTTP real + PostgreSQL real)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  const tokens: Record<string, string> = {};
  const actors: Record<string, string> = {};
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
      ['admin', 'SUPER_ADMIN'],
      ['director', 'INTERNAL_CONTROL_DIRECTOR'],
    ] as const) {
      const user = await createActor(dataSource);
      await dataSource.query(
        `INSERT INTO user_role (user_id, role_id, scope_type) SELECT $1, id, 'GLOBAL' FROM role WHERE code = $2`,
        [user.id, role],
      );
      actors[name] = user.id;
      tokens[name] = app.get(TokenService).signAccessToken({ ...user, sessionId: randomUUID() });
    }
  });

  afterAll(async () => {
    await dataSource.query('UPDATE storage_settings SET project_path = $1', [SHARED_STORAGE_DIR]);
    await app.close();
  });

  describe('BE-01: almacenamiento local', () => {
    it('PATCH /storage/settings con projectPath "/" responde 400 y no cambia la fila', async () => {
      const before = await scalar<string>(dataSource, 'SELECT project_path FROM storage_settings');
      const response = await http()
        .patch('/api/v1/storage/settings')
        .set(auth('admin'))
        .send({ driver: 'project', projectPath: '/' })
        .expect(400);
      expect(response.body.error.code).toBe('STORAGE_PROJECT_PATH_LOCKED');
      expect(await scalar<string>(dataSource, 'SELECT project_path FROM storage_settings')).toBe(before);
    });

    it('el formulario puede reenviar la carpeta que muestra el estado (la del despliegue)', async () => {
      const status = await http().get('/api/v1/storage/status').set(auth('admin')).expect(200);
      expect(status.body.data.projectPath).toBe(process.env['STORAGE_PROJECT_PATH']);
      await http()
        .patch('/api/v1/storage/settings')
        .set(auth('admin'))
        .send({ driver: 'project', projectPath: status.body.data.projectPath })
        .expect(200);
    });

    it.each(['/etc/hostname', '../../etc/hostname', 'a/../../x', '/proc/self/environ', 'C:/Windows/win.ini'])(
      'GET /storage/objects?key=%s responde 400 STORAGE_KEY_INVALID',
      async (key) => {
        const response = await http().get('/api/v1/storage/objects').query({ key }).set(auth('admin')).expect(400);
        expect(response.body.error.code).toBe('STORAGE_KEY_INVALID');
        expect(JSON.stringify(response.body)).not.toContain('hostname');
      },
    );

    it('una project_path manipulada en la BD se ignora: se sigue leyendo de STORAGE_PROJECT_PATH', async () => {
      await mkdir(join(SHARED_STORAGE_DIR, 'be01'), { recursive: true });
      await writeFile(join(SHARED_STORAGE_DIR, 'be01', 'prueba.txt'), 'contenido del volumen');
      await dataSource.query('UPDATE storage_settings SET project_path = $1', ['/']);
      const found = await http()
        .get('/api/v1/storage/objects')
        .query({ key: 'be01/prueba.txt' })
        .set(auth('admin'))
        .buffer(true)
        .expect(200);
      expect(Buffer.from(found.body as Buffer).toString()).toBe('contenido del volumen');
      // Con la raíz en "/" esta clave habría leído el archivo del sistema; ahora apunta dentro del volumen.
      await http().get('/api/v1/storage/objects').query({ key: 'etc/hostname' }).set(auth('admin')).expect(404);
    });
  });

  describe('BE-05: límites de carga', () => {
    const oversize = (limit: number) => Buffer.alloc(limit + 1, 0x41);

    it.each([
      ['/api/v1/imports', UPLOAD_LIMITS.EXCEL_IMPORT.maxFileBytes, 'grande.xlsx', 25],
      ['/api/v1/assets/import', UPLOAD_LIMITS.ASSET_CSV.maxFileBytes, 'grande.csv', 5],
      ['/api/v1/cost-centers/sync', UPLOAD_LIMITS.COST_CENTER_CSV.maxFileBytes, 'grande.csv', 1],
      ['/api/v1/document-templates?documentType=ACTA_BAJA', UPLOAD_LIMITS.DOCX_TEMPLATE.maxFileBytes, 'grande.docx', 10],
      ['/api/v1/documents/formats/OCI-01-55/templates', UPLOAD_LIMITS.DOCX_TEMPLATE.maxFileBytes, 'grande.docx', 10],
    ] as const)('POST %s con un archivo de más de su tope responde 400 FILE_TOO_LARGE', async (url, limit, name, mb) => {
      const response = await http().post(url).set(auth('director')).attach('file', oversize(limit), name).expect(400);
      expect(response.body.error).toMatchObject({
        code: 'FILE_TOO_LARGE',
        message: `El archivo supera el máximo de ${mb} MB`,
      });
    });

    it('un segundo archivo en la misma carga responde 400', async () => {
      const response = await http()
        .post('/api/v1/assets/import')
        .set(auth('director'))
        .attach('file', Buffer.from('description\n'), 'a.csv')
        .attach('file', Buffer.from('description\n'), 'b.csv')
        .expect(400);
      expect(response.body.error.code).toBe('MALFORMED_REQUEST');
    });

    it('demasiados campos de texto en la carga responde 400', async () => {
      let req = http().post('/api/v1/assets/import').set(auth('director'));
      for (let index = 0; index < 10; index += 1) {
        req = req.field(`f${index}`, 'x');
      }
      await req.attach('file', Buffer.from('description\n'), 'a.csv').expect(400);
    });

    it('una carga normal dentro del tope sigue funcionando', async () => {
      const response = await http()
        .post('/api/v1/assets/import')
        .set(auth('director'))
        .attach('file', Buffer.from('description,category_code\n'), 'vacio.csv');
      expect(response.status).not.toBe(413);
      expect(response.body.error?.code).not.toBe('FILE_TOO_LARGE');
    });

    it('un .xlsx de pocos KB con una celda en la fila 1.048.576 se rechaza con 400 en menos de 1 s', async () => {
      const book = new ExcelJS.Workbook();
      book.addWorksheet('Bomba').getCell('A1048576').value = 'x';
      const content = Buffer.from(await book.xlsx.writeBuffer());
      expect(content.length).toBeLessThan(20_000);
      const started = Date.now();
      const response = await http()
        .post('/api/v1/imports')
        .set(auth('director'))
        .attach('file', content, 'bomba.xlsx')
        .expect(400);
      expect(Date.now() - started).toBeLessThan(1000);
      expect(response.body.error.code).toBe('ARCHIVE_TOO_LARGE');
      expect(Number(await scalar<string>(dataSource, `SELECT count(*) FROM staging_batch WHERE file_name = 'bomba.xlsx'`))).toBe(0);
    });
  });

  describe('BE-06: correos con saltos de línea', () => {
    const INJECTED = 'atacante@x.com>\nRCPT TO:<victima@unac.edu.co';

    it('la importación de personas deja la fila del hallazgo en cuarentena (EMAIL_NOT_INSTITUTIONAL) con el motivo', async () => {
      const imports = app.get(ExcelImportService);
      const base = randomUUID().replace(/\D/g, '').padEnd(8, '5').slice(0, 8);
      const book = new ExcelJS.Workbook();
      const sheet = book.addWorksheet('Personas');
      sheet.addRow(['Documento', 'Nombres', 'Apellidos', 'Correo']);
      sheet.addRow([`70${base}`, 'EVA', 'MORA', INJECTED]);
      sheet.addRow([`71${base}`, 'LUIS', 'SOTO', `luis.${base}@unac.edu.co`]);
      sheet.addRow([`72${base}`, 'RAUL', 'PAZ', `raul ${base}@unac.edu.co`]);
      const upload = await imports.upload(Buffer.from(await book.xlsx.writeBuffer()), 'be06.xlsx', actors['director'] ?? '');
      const preview = await imports.preview(
        upload.batchId,
        {
          sheet: 'Personas',
          target: 'PERSONS',
          mapping: { documentNumber: 'A', firstName: 'B', lastName: 'C', email: 'D' },
          documentType: 'CC',
        },
        actors['director'] ?? '',
      );
      expect(preview.summary).toMatchObject({ rowsRead: 3, toInsert: 1, quarantined: { EMAIL_NOT_INSTITUTIONAL: 2 } });
      expect(await app.get(ImportJobsService).runNow(preview.importId, actors['director'] ?? '')).toMatchObject({ inserted: 1 });
      expect(Number(await scalar<string>(dataSource, 'SELECT count(*) FROM person WHERE document_number = ANY($1)', [
        [`70${base}`, `71${base}`, `72${base}`],
      ]))).toBe(1);
      const quarantine = (await imports.quarantine(preview.importId)) as Array<Record<string, unknown>>;
      expect(quarantine.filter((row) => row['reason'] === 'EMAIL_NOT_INSTITUTIONAL')).toEqual([
        expect.objectContaining({ rowNumber: 2, detail: expect.stringContaining('saltos de línea') }),
        expect.objectContaining({ rowNumber: 4, detail: expect.stringContaining('espacios') }),
      ]);
      expect(JSON.stringify(quarantine)).not.toContain('atacante');
    });

    it('la base rechaza un correo con caracteres de control aunque termine en @unac.edu.co', async () => {
      await expect(
        dataSource.query(`INSERT INTO person (first_name, last_name, email) VALUES ('Eva', 'Mora', $1)`, [INJECTED]),
      ).rejects.toThrow(/chk_person_email_single_line/);
    });

    it('PATCH /mail/settings con fromName que contiene CR/LF responde 400', async () => {
      const response = await http()
        .patch('/api/v1/mail/settings')
        .set(auth('admin'))
        .send({ fromName: 'Control Interno\r\nBcc: x@evil.com' })
        .expect(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });
  });
});
