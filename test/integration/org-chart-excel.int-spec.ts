// Excel del organigrama: exportar → importar (previsualizar y confirmar) con HTTP real + PostgreSQL real.
// Ida y vuelta sin cambios = 0 cambios; renombrar, recodificar con «Código anterior», eliminar (borrado físico con
// limpieza de jefaturas y roles con alcance) y eliminar con historia (archiva).
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SchedulerRegistry } from '@nestjs/schedule';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { createAppValidationPipe } from '../../src/common/pipes/app-validation.pipe.js';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';
import { TokenService } from '../../src/modules/auth/services/token.service.js';
import { createActor, openTestSession, scalar } from './helpers.js';
import { conform, type Schema } from './openapi-conform.js';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const binaryParser = (res: request.Response, callback: (error: Error | null, body: Buffer) => void): void => {
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  stream.on('end', () => callback(null, Buffer.concat(chunks)));
};

describe('Excel del organigrama (HTTP real + PostgreSQL real)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let openapi: OpenAPIObject;
  let admin: AuthenticatedUser;
  let reader: AuthenticatedUser;
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};

  const http = () => request(app.getHttpServer());
  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who] ?? ''}` });

  const expectConforms = (method: string, route: string, status: number, body: unknown) => {
    const operation = (
      openapi.paths[route] as Record<string, { responses: Record<string, { content?: Record<string, { schema: Schema }> }> }>
    )[method];
    const schema = operation?.responses[String(status)]?.content?.['application/json']?.schema;
    expect(schema, `${method.toUpperCase()} ${route} ${status} no declara esquema`).toBeDefined();
    const errors: string[] = [];
    conform(openapi, body, schema ?? {}, `${method.toUpperCase()} ${route}`, errors);
    expect(errors).toEqual([]);
  };

  const token = async (user: AuthenticatedUser) =>
    app.get(TokenService).signAccessToken({ ...user, sessionId: await openTestSession(dataSource, user.id) });

  const grant = (userId: string, role: string) =>
    dataSource.query(`INSERT INTO user_role (user_id, role_id, scope_type) SELECT $1, id, 'GLOBAL' FROM role WHERE code = $2`, [
      userId,
      role,
    ]);

  const exportFile = async (): Promise<Buffer> => {
    const response = await http().get('/api/v1/organizational-units/export').set(auth('admin')).buffer(true).parse(binaryParser);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain(XLSX);
    return response.body as Buffer;
  };

  const preview = (file: Buffer, who = 'admin') =>
    http().post('/api/v1/organizational-units/import/preview').set(auth(who)).attach('file', file, 'organigrama.xlsx');

  const confirm = (previewId: string, who = 'admin') =>
    http().post(`/api/v1/organizational-units/import/${previewId}/confirm`).set(auth(who));

  const centerByCode = async (code: string) =>
    (
      (await dataSource.query('SELECT id, external_code, name, is_active, parent_id, organizational_unit_id FROM cost_center WHERE external_code = $1', [
        code,
      ])) as Array<{ id: string; external_code: string; name: string; is_active: boolean; parent_id: string | null; organizational_unit_id: string | null }>
    )[0];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
    for (const job of app.get(SchedulerRegistry).getCronJobs().values()) {
      await job.stop();
    }
    dataSource = app.get(DataSource);
    openapi = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    admin = await createActor(dataSource);
    await grant(admin.id, 'INTERNAL_CONTROL_DIRECTOR');
    tokens['admin'] = await token(admin);
    reader = await createActor(dataSource);
    await grant(reader.id, 'AUDITOR');
    tokens['reader'] = await token(reader);

    const unit = async (key: string, body: Record<string, unknown>) => {
      const response = await http().post('/api/v1/organizational-units').set(auth('admin')).send(body);
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      ids[key] = response.body.data.id as string;
    };
    await unit('u6', { code: 'IT_OC_SEIS', name: 'Vicerrectoría Excel', type: 'VICERECTORATE', codePrefix: '6' });
    await unit('u61', { code: 'IT_OC_SESENTAYUNO', name: 'Departamento Excel', type: 'DEPARTMENT', codePrefix: '61', parentId: ids['u6'] });
    const center = async (code: string, body: Record<string, unknown> = {}) => {
      const response = await http()
        .post('/api/v1/cost-centers')
        .set(auth('admin'))
        .send({ externalCode: code, name: `CENTRO ${code}`, organizationalUnitId: ids['u61'], ...body });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      ids[code] = response.body.data.id as string;
    };
    await center('6110');
    await center('6111', { parentId: ids['6110'] });
    await center('6115');
    await center('6130');
    await center('6140');
    // 6130: jefatura y rol con alcance en el centro (se limpian al borrar). 6140: un activo dado de baja (historia).
    await dataSource.query(`INSERT INTO cost_center_head (person_id, cost_center_id, reason) VALUES ($1, $2, 'Prueba de borrado')`, [
      admin.personId,
      ids['6130'],
    ]);
    await dataSource.query(
      `INSERT INTO user_role (user_id, role_id, scope_type, scope_id) SELECT $1, id, 'COST_CENTER', $2 FROM role WHERE code = 'DEPARTMENT_HEAD'`,
      [reader.id, ids['6130']],
    );
    const categoryId = await scalar<string>(dataSource, `INSERT INTO asset_category (code, name) VALUES ($1, 'Organigrama') RETURNING id`, [
      `OC-${randomUUID().slice(0, 6)}`,
    ]);
    await dataSource.query(
      `INSERT INTO asset (internal_code, description, category_id, acquisition_type_id, acquisition_date, current_cost_center_id,
         created_by, operational_status, written_off_at)
       VALUES ($1, 'Activo dado de baja', $2, (SELECT id FROM acquisition_type WHERE code = 'PURCHASE'), '2021-03-01', $3, $4,
         'WRITTEN_OFF', NOW())`,
      [`OC-${randomUUID().slice(0, 8)}`, categoryId, ids['6140'], admin.id],
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('exportar exige org_unit:read; previsualizar exige org_unit:manage', async () => {
    const anonymous = await http().get('/api/v1/organizational-units/export');
    expect(anonymous.status).toBe(401);
    const denied = await preview(Buffer.from('x'), 'reader');
    expect(denied.status).toBe(403);
    const template = await http().get('/api/v1/organizational-units/template').set(auth('admin')).buffer(true).parse(binaryParser);
    expect(template.status).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(template.body as unknown as ArrayBuffer);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['Organigrama', 'Centros de costo', 'Instrucciones']);
  });

  it('ida y vuelta: tras normalizar, el mismo archivo exportado da 0 cambios', async () => {
    // Otros archivos de prueba dejan centros con la regla vieja de padres: la primera importación los normaliza.
    const first = await preview(await exportFile());
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expectConforms('post', '/api/v1/organizational-units/import/preview', 201, first.body);
    expect(first.body.data.errors).toEqual([]);
    if (first.body.data.canConfirm) {
      const applied = await confirm(first.body.data.previewId as string);
      expect(applied.status, JSON.stringify(applied.body)).toBe(201);
    }
    const again = await preview(await exportFile());
    expect(again.status).toBe(201);
    expect(again.body.data.summary.totalChanges).toBe(0);
    expect(again.body.data.changes).toEqual([]);
    expect(again.body.data.canConfirm).toBe(false);
  });

  it('renombrar, recodificar, crear, eliminar y archivar en una confirmación', async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await exportFile()) as unknown as ArrayBuffer);
    const centers = workbook.getWorksheet('Centros de costo');
    const units = workbook.getWorksheet('Organigrama');
    if (!centers || !units) {
      throw new Error('faltan hojas');
    }
    const rowOf = (sheet: ExcelJS.Worksheet, value: string): ExcelJS.Row => {
      let found: ExcelJS.Row | undefined;
      sheet.eachRow((row) => {
        if (String(row.getCell(1).value ?? '') === value) {
          found = row;
        }
      });
      if (!found) {
        throw new Error(`no está ${value}`);
      }
      return found;
    };
    expect(rowOf(centers, '6111').getCell(5).value).toBe('6110');
    expect(rowOf(centers, '6115').getCell(5).value).toBeNull();
    rowOf(centers, '6111').getCell(2).value = 'CENTRO 6111 RENOMBRADO';
    const recode = rowOf(centers, '6115');
    recode.getCell(1).value = '6125';
    recode.getCell(9).value = '6115';
    rowOf(centers, '6130').getCell(8).value = 'ELIMINAR';
    rowOf(centers, '6140').getCell(8).value = 'ELIMINAR';
    const next = centers.rowCount + 1;
    centers.getRow(next).values = ['6210', 'CENTRO NUEVO 6210', 1];
    units.getRow(units.rowCount + 1).values = ['62', 'Oficina Excel', 'Oficina', '6', 'Autoridad', '6210'];
    const file = Buffer.from(await workbook.xlsx.writeBuffer());

    const previewed = await preview(file);
    expect(previewed.status, JSON.stringify(previewed.body)).toBe(201);
    const data = previewed.body.data;
    expect(data.errors).toEqual([]);
    expect(data.summary.units).toMatchObject({ created: 1 });
    expect(data.summary.centers).toMatchObject({ created: 1, renamed: 1, recoded: 1, deleted: 1, archived: 1 });
    expect(data.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining('No se elimina: Se archiva porque tiene historia') })]),
    );
    expect(data.requiresCostCenterPermission).toBe(true);
    expect(data.canConfirm).toBe(true);

    const applied = await confirm(data.previewId as string);
    expect(applied.status, JSON.stringify(applied.body)).toBe(201);
    expectConforms('post', '/api/v1/organizational-units/import/{previewId}/confirm', 201, applied.body);

    expect(await centerByCode('6130')).toBeUndefined();
    const heads = await scalar<number>(dataSource, 'SELECT count(*)::int FROM cost_center_head WHERE cost_center_id = $1', [ids['6130']]);
    const roles = await scalar<number>(dataSource, `SELECT count(*)::int FROM user_role WHERE scope_type = 'COST_CENTER' AND scope_id = $1`, [ids['6130']]);
    expect([heads, roles]).toEqual([0, 0]);
    expect(await centerByCode('6140')).toMatchObject({ is_active: false });
    expect(await centerByCode('6125')).toMatchObject({ id: ids['6115'] });
    expect(await centerByCode('6111')).toMatchObject({ name: 'CENTRO 6111 RENOMBRADO', parent_id: ids['6110'] });
    const office = (await dataSource.query(`SELECT id, parent_id, head_cost_center_id, hierarchy_level FROM organizational_unit WHERE code_prefix = '62' AND is_active`)) as Array<{
      id: string;
      parent_id: string;
      head_cost_center_id: string;
      hierarchy_level: number;
    }>;
    const created = await centerByCode('6210');
    expect(office[0]).toMatchObject({ parent_id: ids['u6'], head_cost_center_id: created?.id, hierarchy_level: 1 });
    expect(created).toMatchObject({ organizational_unit_id: office[0]?.id, parent_id: null });
    const history = (await dataSource.query(
      `SELECT field, old_value, new_value FROM org_structure_history WHERE entity_id = $1 ORDER BY field`,
      [ids['6115']],
    )) as unknown[];
    expect(history).toEqual([{ field: 'CODE', old_value: '6115', new_value: '6125' }]);
    const audit = await scalar<number>(dataSource, `SELECT count(*)::int FROM audit_log WHERE action = 'ORG_CHART_IMPORTED' AND entity_id = $1`, [
      data.previewId,
    ]);
    expect(audit).toBe(1);

    const twice = await confirm(data.previewId as string);
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('ORG_CHART_IMPORT_CLOSED');

    const after = await preview(await exportFile());
    expect(after.body.data.summary.totalChanges).toBe(0);
  });

  it('un error de fila bloquea la confirmación', async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await exportFile()) as unknown as ArrayBuffer);
    const units = workbook.getWorksheet('Organigrama');
    if (!units) {
      throw new Error('falta la hoja');
    }
    units.getRow(units.rowCount + 1).values = ['73', 'Fuera de rango', 'Oficina', '6'];
    const previewed = await preview(Buffer.from(await workbook.xlsx.writeBuffer()));
    expect(previewed.status).toBe(201);
    expect(previewed.body.data.canConfirm).toBe(false);
    expect(previewed.body.data.errors[0].message).toContain('debe ser 6 seguido de un dígito');
    const rejected = await confirm(previewed.body.data.previewId as string);
    expect(rejected.status).toBe(422);
    expect(rejected.body.error.code).toBe('ORG_CHART_IMPORT_HAS_ERRORS');
  });
});
