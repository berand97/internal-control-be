// Excel del organigrama: exportar → importar (previsualizar y confirmar) con HTTP real + PostgreSQL real.
// Solo unidades: ida y vuelta sin cambios = 0 cambios; una hoja vieja «Centros de costo» se ignora con advertencia y
// la confirmación no exige permisos sobre centros. Además, el DELETE de centros y unidades.
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

  /** Edita un archivo exportado (conserva el sello) y lo devuelve como se subiría. */
  const editExport = async (file: Buffer, mutate: (sheet: ExcelJS.Worksheet) => void): Promise<Buffer> => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file as unknown as ArrayBuffer);
    const sheet = workbook.getWorksheet('Organigrama');
    if (!sheet) {
      throw new Error('falta la hoja');
    }
    mutate(sheet);
    return Buffer.from(await workbook.xlsx.writeBuffer());
  };

  const rowByPrefix = (sheet: ExcelJS.Worksheet, prefix: string): ExcelJS.Row => {
    let found: ExcelJS.Row | undefined;
    sheet.eachRow((row) => {
      if (String(row.getCell(1).value ?? '') === prefix) {
        found = row;
      }
    });
    if (!found) {
      throw new Error(`no está la ${prefix}`);
    }
    return found;
  };

  const unitName = (id: string | undefined) => scalar<string>(dataSource, 'SELECT name FROM organizational_unit WHERE id = $1', [id]);

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
    // Centro de la vicerrectoría que será el Centro propio de la oficina 62 creada desde el Excel.
    await center('6210', { organizationalUnitId: ids['u6'] });
    await dataSource.query(`INSERT INTO asset_category (code, name) VALUES ($1, 'Organigrama')`, [`OC-${randomUUID().slice(0, 6)}`]);
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
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['Organigrama', 'Instrucciones', '_sello']);
    const exported = new ExcelJS.Workbook();
    await exported.xlsx.load((await exportFile()) as unknown as ArrayBuffer);
    expect(exported.worksheets.map((sheet) => sheet.name)).toEqual(['Organigrama', 'Instrucciones', '_sello']);
    expect(exported.getWorksheet('_sello')?.state).toBe('veryHidden');
  });

  it('ida y vuelta: tras normalizar, el mismo archivo exportado da 0 cambios', async () => {
    // Otros archivos de prueba pueden dejar unidades que la primera importación normaliza.
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

  it('solo unidades: la hoja vieja «Centros de costo» se ignora con advertencia y se confirma sin permiso de centros', async () => {
    // Usuario que administra unidades pero no centros de costo.
    const roleCode = `IT_OC_UNIDADES_${randomUUID().slice(0, 6).toUpperCase()}`;
    await dataSource.query(`INSERT INTO role (code, name) VALUES ($1, 'Solo unidades')`, [roleCode]);
    await dataSource.query(
      `INSERT INTO role_permission (role_id, permission_id)
       SELECT r.id, p.id FROM role r JOIN permission p ON p.code IN ('org_unit:read:global', 'org_unit:manage:global') WHERE r.code = $1`,
      [roleCode],
    );
    const unitsAdmin = await createActor(dataSource);
    await grant(unitsAdmin.id, roleCode);
    tokens['units'] = await token(unitsAdmin);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await exportFile()) as unknown as ArrayBuffer);
    const units = workbook.getWorksheet('Organigrama');
    if (!units) {
      throw new Error('falta la hoja');
    }
    let department: ExcelJS.Row | undefined;
    units.eachRow((row) => {
      if (String(row.getCell(1).value ?? '') === '61') {
        department = row;
      }
    });
    if (!department) {
      throw new Error('no está la 61');
    }
    department.getCell(2).value = 'Departamento Excel renombrado';
    units.getRow(units.rowCount + 1).values = ['62', 'Oficina Excel', 'Oficina', '6', 'Autoridad', '6210'];
    // Hoja de un archivo viejo: renombrar, eliminar y crear centros. Nada de esto se aplica.
    const old = workbook.addWorksheet('Centros de costo');
    old.addRow(['Código', 'Nombre', 'Movimiento', 'Unidad', 'Padre', 'Activos', 'Estado', 'Acción', 'Código anterior']);
    old.addRow(['6111', 'CENTRO 6111 RENOMBRADO', 1, null, null, 0, 'Activo', null, null]);
    old.addRow(['6130', 'CENTRO 6130', 1, null, null, 0, 'Activo', 'ELIMINAR', null]);
    old.addRow(['6299', 'CENTRO NUEVO 6299', 1]);
    old.addRow(['6125', 'CENTRO 6115', 1, null, null, 0, 'Activo', null, '6115']);

    const previewed = await preview(Buffer.from(await workbook.xlsx.writeBuffer()), 'units');
    expect(previewed.status, JSON.stringify(previewed.body)).toBe(201);
    expectConforms('post', '/api/v1/organizational-units/import/preview', 201, previewed.body);
    const data = previewed.body.data;
    expect(data.errors).toEqual([]);
    expect(data.summary.units).toMatchObject({ created: 1, renamed: 1 });
    expect(data.summary.centers).toEqual({
      created: 0,
      renamed: 0,
      recoded: 0,
      relocated: 0,
      movementChanged: 0,
      reactivated: 0,
      archived: 0,
      deleted: 0,
    });
    expect(data.summary.totalChanges).toBe(2);
    expect(data.changes.map((change: { entity: string }) => change.entity)).toEqual(['ORG_UNIT', 'ORG_UNIT']);
    expect(data.warnings).toEqual(
      expect.arrayContaining([
        {
          sheet: 'Centros de costo',
          rowNumber: 1,
          column: null,
          message: 'La hoja Centros de costo se ignoró: los centros se administran en su propia pantalla',
        },
      ]),
    );
    expect(data.requiresCostCenterPermission).toBe(false);
    expect(data.canConfirm).toBe(true);

    const applied = await confirm(data.previewId as string, 'units');
    expect(applied.status, JSON.stringify(applied.body)).toBe(201);
    expectConforms('post', '/api/v1/organizational-units/import/{previewId}/confirm', 201, applied.body);

    // Los centros quedan como estaban.
    expect(await centerByCode('6111')).toMatchObject({ name: 'CENTRO 6111', parent_id: ids['6110'], is_active: true });
    expect(await centerByCode('6130')).toMatchObject({ id: ids['6130'], is_active: true });
    expect(await centerByCode('6115')).toMatchObject({ id: ids['6115'] });
    expect(await centerByCode('6125')).toBeUndefined();
    expect(await centerByCode('6299')).toBeUndefined();
    // Las unidades sí cambian: la 62 nueva toma como Centro propio el 6210 que ya existía.
    const office = (await dataSource.query(
      `SELECT id, parent_id, head_cost_center_id, hierarchy_level FROM organizational_unit WHERE code_prefix = '62' AND is_active`,
    )) as Array<{ id: string; parent_id: string; head_cost_center_id: string; hierarchy_level: number }>;
    expect(office[0]).toMatchObject({ parent_id: ids['u6'], head_cost_center_id: ids['6210'], hierarchy_level: 1 });
    // El conciliador (misma transacción) lleva el 6210 a la unidad 62: el código manda (prefijo más largo).
    expect(await centerByCode('6210')).toMatchObject({ organizational_unit_id: office[0]?.id });
    expect(await scalar<string>(dataSource, 'SELECT name FROM organizational_unit WHERE id = $1', [ids['u61']])).toBe(
      'Departamento Excel renombrado',
    );
    const audit = await scalar<number>(dataSource, `SELECT count(*)::int FROM audit_log WHERE action = 'ORG_CHART_IMPORTED' AND entity_id = $1`, [
      data.previewId,
    ]);
    expect(audit).toBe(1);

    const twice = await confirm(data.previewId as string, 'units');
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
    // 641 bajo 61 no empieza por el de su jefe: solo advertencia. Dos filas con el mismo prefijo 64: error.
    units.getRow(units.rowCount + 1).values = ['64', 'Otra oficina', 'Oficina', '6'];
    units.getRow(units.rowCount + 1).values = ['641', 'Fuera de rango', 'Oficina', '61'];
    units.getRow(units.rowCount + 1).values = ['64', 'Repetida', 'Oficina', '6'];
    const previewed = await preview(Buffer.from(await workbook.xlsx.writeBuffer()));
    expect(previewed.status).toBe(201);
    expect(previewed.body.data.canConfirm).toBe(false);
    expect(previewed.body.data.errors).toEqual([expect.objectContaining({ column: 'Prefijo', message: expect.stringContaining('64') })]);
    expect(previewed.body.data.warnings).toContainEqual(
      expect.objectContaining({
        message: 'Fuera de rango (641) depende de Departamento Excel renombrado (61) pero conserva los códigos 641… de Otra oficina',
      }),
    );
    const rejected = await confirm(previewed.body.data.previewId as string);
    expect(rejected.status).toBe(422);
    expect(rejected.body.error.code).toBe('ORG_CHART_IMPORT_HAS_ERRORS');
  });
  it('DELETE de un centro: sin historia lo borra con jefaturas y roles; con historia lo archiva; el árbol solo muestra activos', async () => {
    const make = async (code: string) => {
      const response = await http()
        .post('/api/v1/cost-centers')
        .set(auth('admin'))
        .send({ externalCode: code, name: `CENTRO ${code}`, organizationalUnitId: ids['u61'] });
      expect(response.status).toBe(201);
      return response.body.data.id as string;
    };
    const plain = await make('6160');
    await dataSource.query(`INSERT INTO cost_center_head (person_id, cost_center_id, reason) VALUES ($1, $2, 'Prueba')`, [admin.personId, plain]);
    await dataSource.query(
      `INSERT INTO user_role (user_id, role_id, scope_type, scope_id) SELECT $1, id, 'COST_CENTER', $2 FROM role WHERE code = 'DEPARTMENT_HEAD'`,
      [reader.id, plain],
    );
    const removed = await http().delete(`/api/v1/cost-centers/${plain}`).set(auth('admin'));
    expect(removed.status).toBe(200);
    expectConforms('delete', '/api/v1/cost-centers/{id}', 200, removed.body);
    expect(removed.body.data).toEqual({ deleted: true, archived: false, reason: null });
    expect(await centerByCode('6160')).toBeUndefined();
    expect(await scalar<number>(dataSource, `SELECT count(*)::int FROM user_role WHERE scope_id = $1`, [plain])).toBe(0);
    const audit = (await dataSource.query(`SELECT changes FROM audit_log WHERE entity_id = $1 AND action = 'COST_CTR_DELETED'`, [plain])) as Array<{
      changes: Record<string, unknown>;
    }>;
    expect(audit[0]?.changes).toMatchObject({ externalCode: '6160', name: 'CENTRO 6160', physical: true });

    const withHistory = await make('6170');
    const category = await scalar<string>(dataSource, `SELECT id FROM asset_category LIMIT 1`);
    await dataSource.query(
      `INSERT INTO asset (internal_code, description, category_id, acquisition_type_id, acquisition_date, current_cost_center_id,
         created_by, operational_status, written_off_at)
       VALUES ($1, 'Baja', $2, (SELECT id FROM acquisition_type WHERE code = 'PURCHASE'), '2021-03-01', $3, $4, 'WRITTEN_OFF', NOW())`,
      [`OC-${randomUUID().slice(0, 8)}`, category, withHistory, admin.id],
    );
    const archived = await http().delete(`/api/v1/cost-centers/${withHistory}`).set(auth('admin'));
    expect(archived.status).toBe(200);
    expect(archived.body.data).toMatchObject({ deleted: false, archived: true, reason: expect.stringContaining('activos (dados de baja)') });

    const tree = await http().get('/api/v1/cost-centers/tree').set(auth('admin'));
    expect(JSON.stringify(tree.body.data.roots)).not.toContain('"6170"');
    const all = await http().get('/api/v1/cost-centers/tree?includeArchived=true').set(auth('admin'));
    expect(JSON.stringify(all.body.data.roots)).toContain('"6170"');

    const history = await http().get(`/api/v1/cost-centers/${withHistory}/history`).set(auth('admin'));
    expect(history.status).toBe(200);
    expectConforms('get', '/api/v1/cost-centers/{id}/history', 200, history.body);
    expect(history.body.data.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'ATTRIBUTE', attribute: expect.objectContaining({ field: 'STATUS', newValue: 'ARCHIVED' }) }),
      ]),
    );
  });

  it('DELETE de una unidad sin nada la borra; el árbol de unidades por defecto solo muestra activas', async () => {
    const created = await http()
      .post('/api/v1/organizational-units')
      .set(auth('admin'))
      .send({ code: 'IT_OC_BORRABLE', name: 'Unidad borrable', type: 'OFFICE', parentId: ids['u6'], codePrefix: '69' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    // 691 bajo 61 no empieza por 61 y los números 69… son de la unidad recién creada: se acepta con advertencia.
    const outOfParent = await http()
      .post('/api/v1/organizational-units')
      .set(auth('admin'))
      .send({ code: 'IT_OC_MAL', name: 'Mal prefijo', type: 'OFFICE', parentId: ids['u61'], codePrefix: '691' });
    expect(outOfParent.status).toBe(201);
    expect(outOfParent.body.data.warnings).toEqual([
      'Mal prefijo (691) depende de Departamento Excel renombrado (61) pero conserva los códigos 691… de Unidad borrable',
    ]);
    // El mismo prefijo de su jefe sí es error.
    const samePrefix = await http()
      .post('/api/v1/organizational-units')
      .set(auth('admin'))
      .send({ code: 'IT_OC_MISMO', name: 'Mismo prefijo', type: 'OFFICE', parentId: ids['u61'], codePrefix: '61' });
    expect(samePrefix.status).toBe(400);
    expect(samePrefix.body.error.code).toBe('ORG_UNIT_PREFIX_OUT_OF_PARENT');
    const archivedUnit = await http()
      .post('/api/v1/organizational-units')
      .set(auth('admin'))
      .send({ code: 'IT_OC_ARCHIVADA', name: 'Unidad archivada', type: 'COUNCIL', parentId: ids['u6'], isActive: false });
    expect(archivedUnit.status).toBe(201);
    const tree = await http().get('/api/v1/organizational-units/tree').set(auth('admin'));
    expect(JSON.stringify(tree.body.data)).not.toContain('IT_OC_ARCHIVADA');
    const withArchived = await http().get('/api/v1/organizational-units/tree?includeArchived=true').set(auth('admin'));
    expect(JSON.stringify(withArchived.body.data)).toContain('IT_OC_ARCHIVADA');

    const renamed = await http()
      .patch(`/api/v1/organizational-units/${created.body.data.id}`)
      .set(auth('admin'))
      .send({ name: 'Unidad borrable renombrada' });
    expect(renamed.status).toBe(200);
    const unitHistory = await http().get(`/api/v1/organizational-units/${created.body.data.id}/history`).set(auth('admin'));
    expect(unitHistory.status).toBe(200);
    expectConforms('get', '/api/v1/organizational-units/{id}/history', 200, unitHistory.body);
    expect(unitHistory.body.data).toEqual([
      expect.objectContaining({ field: 'NAME', oldValue: 'Unidad borrable', newValue: 'Unidad borrable renombrada', source: 'MANUAL' }),
    ]);

    const removed = await http().delete(`/api/v1/organizational-units/${created.body.data.id}`).set(auth('admin'));
    expect(removed.status).toBe(200);
    expectConforms('delete', '/api/v1/organizational-units/{id}', 200, removed.body);
    expect(removed.body.data).toEqual({ deleted: true, archived: false, reason: null });
    expect(await scalar<number>(dataSource, 'SELECT count(*)::int FROM organizational_unit WHERE id = $1', [created.body.data.id])).toBe(0);

  });

  describe('archivos viejos (sello oculto)', () => {
    it('la plantilla trae la hoja Organigrama vacía: subida tal cual no cambia nada', async () => {
      const template = await http().get('/api/v1/organizational-units/template').set(auth('admin')).buffer(true).parse(binaryParser);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(template.body as unknown as ArrayBuffer);
      expect(workbook.getWorksheet('Organigrama')?.actualRowCount).toBe(1);
      const previewed = await preview(template.body as Buffer);
      expect(previewed.status, JSON.stringify(previewed.body)).toBe(201);
      expect(previewed.body.data).toMatchObject({ canConfirm: false, conflicts: [], fileAppliedBefore: null, fileAgeDays: 0 });
      expect(previewed.body.data.summary.totalChanges).toBe(0);
    });

    it('archivo viejo sin tocar no revierte un renombre hecho después; la fila tocada sí se aplica', async () => {
      const old = await exportFile();
      const patched = await http().patch(`/api/v1/organizational-units/${ids['u6']}`).set(auth('admin')).send({ name: 'Vicerrectoría Excel (nuevo nombre)' });
      expect(patched.status, JSON.stringify(patched.body)).toBe(200);
      const untouched = await preview(old);
      expect(untouched.status).toBe(201);
      expectConforms('post', '/api/v1/organizational-units/import/preview', 201, untouched.body);
      expect(untouched.body.data).toMatchObject({ canConfirm: false, conflicts: [], errors: [] });
      expect(untouched.body.data.summary.totalChanges).toBe(0);

      const touched = await preview(await editExport(old, (sheet) => (rowByPrefix(sheet, '61').getCell(5).value = 'Asesoría')));
      expect(touched.body.data.errors).toEqual([]);
      expect(touched.body.data.changes).toEqual([expect.objectContaining({ code: '61', kind: 'RELATION_CHANGED' })]);
      expect((await confirm(touched.body.data.previewId as string)).status).toBe(201);
      expect(await unitName(ids['u6'])).toBe('Vicerrectoría Excel (nuevo nombre)');
    });

    it('mismo archivo dos veces: 0 cambios y aviso «ya se aplicó» con quién y cuándo', async () => {
      const file = await editExport(await exportFile(), (sheet) => (rowByPrefix(sheet, '61').getCell(2).value = 'Departamento Excel dos veces'));
      const first = await preview(file);
      expect(first.body.data.fileAppliedBefore).toBeNull();
      expect((await confirm(first.body.data.previewId as string)).status).toBe(201);
      const again = await preview(file);
      expect(again.status).toBe(201);
      expectConforms('post', '/api/v1/organizational-units/import/preview', 201, again.body);
      expect(again.body.data).toMatchObject({
        canConfirm: false,
        conflicts: [],
        errors: [],
        fileAppliedBefore: { at: expect.any(String), by: expect.any(String) },
      });
      expect(again.body.data.summary.totalChanges).toBe(0);
      expect(again.body.data.warnings[0]).toMatchObject({ rowNumber: 1, message: expect.stringMatching(/^Este archivo ya se aplicó el /) });
      const stored = await scalar<string>(dataSource, `SELECT confirmed_by FROM org_chart_import WHERE id = $1`, [first.body.data.previewId]);
      expect(stored).toBe(admin.id);
    });

    it('dos personas con archivos del mismo momento cambian el mismo nombre: conflicto para la segunda (409 al confirmar)', async () => {
      const base = await exportFile();
      const mine = await editExport(base, (sheet) => (rowByPrefix(sheet, '61').getCell(2).value = 'Departamento Excel A'));
      const theirs = await editExport(base, (sheet) => (rowByPrefix(sheet, '61').getCell(2).value = 'Departamento Excel B'));
      const otherColumn = await editExport(base, (sheet) => (rowByPrefix(sheet, '61').getCell(5).value = 'Coordinación'));
      const first = await preview(mine);
      expect((await confirm(first.body.data.previewId as string)).status).toBe(201);

      const second = await preview(theirs);
      expect(second.status).toBe(201);
      expectConforms('post', '/api/v1/organizational-units/import/preview', 201, second.body);
      expect(second.body.data.canConfirm).toBe(false);
      expect(second.body.data.conflicts).toEqual([
        {
          rowNumber: expect.any(Number),
          unitName: 'Departamento Excel A',
          column: 'Nombre',
          fileValue: 'Departamento Excel B',
          currentValue: 'Departamento Excel A',
          changedAt: expect.any(String),
          changedBy: expect.any(String),
        },
      ]);
      expect(second.body.data.errors).toEqual([expect.objectContaining({ column: 'Nombre', message: expect.stringContaining('Descargue el organigrama de nuevo') })]);
      const rejected = await confirm(second.body.data.previewId as string);
      expect(rejected.status).toBe(409);
      expect(rejected.body.error.code).toBe('ORG_CHART_IMPORT_CONFLICT');

      // Otra columna de la misma unidad, del mismo archivo base: se aplica y conserva el nombre de la primera.
      const third = await preview(otherColumn);
      expect(third.body.data.errors).toEqual([]);
      expect(third.body.data.changes).toEqual([expect.objectContaining({ kind: 'RELATION_CHANGED' })]);
      expect((await confirm(third.body.data.previewId as string)).status).toBe(201);
      expect(await unitName(ids['u61'])).toBe('Departamento Excel A');
    });

    it('una unidad eliminada después de la descarga no se vuelve a crear', async () => {
      const created = await http()
        .post('/api/v1/organizational-units')
        .set(auth('admin'))
        .send({ code: 'IT_OC_EFIMERA', name: 'Unidad efímera', type: 'OFFICE', parentId: ids['u6'], codePrefix: '67' });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const old = await editExport(await exportFile(), (sheet) => (rowByPrefix(sheet, '67').getCell(2).value = 'Unidad efímera renombrada'));
      expect((await http().delete(`/api/v1/organizational-units/${created.body.data.id}`).set(auth('admin'))).status).toBe(200);
      const previewed = await preview(old);
      expect(previewed.body.data.errors).toEqual([]);
      expect(previewed.body.data.summary.totalChanges).toBe(0);
      expect(previewed.body.data.warnings).toContainEqual(
        expect.objectContaining({ column: 'Código interno', message: expect.stringContaining('«Unidad efímera» se eliminó el ') }),
      );
    });
  });

  it('sugerencias: prefijo de unidad, código bajo XYZ0 y en la unidad; 6181 sin 6180 aparece en códigos que no cuadran', async () => {
    const prefix = await http().get(`/api/v1/organizational-units/suggest-prefix?parentId=${ids['u6']}`).set(auth('admin'));
    expect(prefix.status).toBe(200);
    expectConforms('get', '/api/v1/organizational-units/suggest-prefix', 200, prefix.body);
    expect(prefix.body.data).toMatchObject({ fixedPrefix: '6', suggested: '63', taken: expect.arrayContaining(['61', '62']) });

    const underGroup = await http().get(`/api/v1/cost-centers/suggest-code?parentId=${ids['6110']}`).set(auth('admin'));
    expect(underGroup.status).toBe(200);
    expectConforms('get', '/api/v1/cost-centers/suggest-code', 200, underGroup.body);
    expect(underGroup.body.data).toMatchObject({ fixedPrefix: '611', code: '6112', basis: 'PARENT' });
    const inUnit = await http().get(`/api/v1/cost-centers/suggest-code?unitId=${ids['u61']}`).set(auth('admin'));
    expect(inUnit.body.data).toMatchObject({ fixedPrefix: '61', code: '6120', basis: 'UNIT' });

    const orphan = await http()
      .post('/api/v1/cost-centers')
      .set(auth('admin'))
      .send({ externalCode: '6181', name: 'Sin padre', organizationalUnitId: ids['u61'] });
    expect(orphan.status).toBe(201);
    const mismatches = await http().get('/api/v1/cost-centers/prefix-mismatches').set(auth('admin'));
    expectConforms('get', '/api/v1/cost-centers/prefix-mismatches', 200, mismatches.body);
    expect(mismatches.body.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ externalCode: '6181', reason: 'EXPECTED_PARENT_MISSING', expectedParentCode: '6180' })]),
    );
  });

  describe('color base de la rama', () => {
    const colorColumn = (sheet: ExcelJS.Worksheet): number => {
      let column = 0;
      sheet.getRow(1).eachCell((cell, index) => {
        if (cell.value === 'Color') {
          column = index;
        }
      });
      expect(column).toBeGreaterThan(0);
      return column;
    };
    const colorOf = (id: string | undefined) =>
      scalar<string | null>(dataSource, 'SELECT color FROM organizational_unit WHERE id = $1', [id]);
    const findNode = (nodes: ReadonlyArray<Record<string, unknown>>, id: string | undefined): Record<string, unknown> | undefined => {
      for (const node of nodes) {
        if (node['id'] === id) {
          return node;
        }
        const found = findNode((node['children'] as Array<Record<string, unknown>> | undefined) ?? [], id);
        if (found) {
          return found;
        }
      }
      return undefined;
    };

    it('POST/PATCH guardan el color en minúsculas, null lo quita, inválido da 400 en español; el árbol trae effectiveColor', async () => {
      const created = await http()
        .post('/api/v1/organizational-units')
        .set(auth('admin'))
        .send({ code: 'IT_OC_COLOR', name: 'Unidad con color', type: 'OFFICE', parentId: ids['u6'], color: '#ABCDEF' });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expectConforms('post', '/api/v1/organizational-units', 201, created.body);
      expect(created.body.data.color).toBe('#abcdef');
      ids['colored'] = created.body.data.id as string;

      const patched = await http().patch(`/api/v1/organizational-units/${ids['u6']}`).set(auth('admin')).send({ color: '#DE9927' });
      expect(patched.status, JSON.stringify(patched.body)).toBe(200);
      expectConforms('patch', '/api/v1/organizational-units/{id}', 200, patched.body);
      expect(patched.body.data.color).toBe('#de9927');
      expect(await colorOf(ids['u6'])).toBe('#de9927');

      const invalid = await http().patch(`/api/v1/organizational-units/${ids['u6']}`).set(auth('admin')).send({ color: 'DE9927' });
      expect(invalid.status).toBe(400);
      expect(JSON.stringify(invalid.body)).toContain('El color debe tener el formato #RRGGBB, por ejemplo #DE9927');
      expect(await colorOf(ids['u6'])).toBe('#de9927');

      const detail = await http().get(`/api/v1/organizational-units/${ids['u6']}`).set(auth('admin'));
      expectConforms('get', '/api/v1/organizational-units/{id}', 200, detail.body);
      expect(detail.body.data.color).toBe('#de9927');
      const list = await http().get('/api/v1/organizational-units').set(auth('admin'));
      expectConforms('get', '/api/v1/organizational-units', 200, list.body);
      expect(list.body.data.find((item: { id: string }) => item.id === ids['u61'])).toMatchObject({ color: null });

      for (const path of ['/api/v1/organizational-units/tree', '/api/v1/organizational-units/tree?includeArchived=true']) {
        const tree = await http().get(path).set(auth('admin'));
        expect(tree.status).toBe(200);
        expectConforms('get', '/api/v1/organizational-units/tree', 200, tree.body);
        expect(findNode(tree.body.data, ids['u6'])).toMatchObject({ color: '#de9927', effectiveColor: '#de9927' });
        expect(findNode(tree.body.data, ids['u61'])).toMatchObject({ color: null, effectiveColor: '#de9927' });
        expect(findNode(tree.body.data, ids['colored'])).toMatchObject({ color: '#abcdef', effectiveColor: '#abcdef' });
      }
      const subtree = await http().get(`/api/v1/organizational-units/${ids['u6']}/descendants`).set(auth('admin'));
      expectConforms('get', '/api/v1/organizational-units/{id}/descendants', 200, subtree.body);
      expect(findNode(subtree.body.data, ids['u61'])).toMatchObject({ effectiveColor: '#de9927' });

      const cleared = await http().patch(`/api/v1/organizational-units/${ids['colored']}`).set(auth('admin')).send({ color: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body.data.color).toBeNull();
      const kept = await http().patch(`/api/v1/organizational-units/${ids['u6']}`).set(auth('admin')).send({ isActive: true });
      expect(kept.body.data.color).toBe('#de9927');

      const history = await http().get(`/api/v1/organizational-units/${ids['colored']}/history`).set(auth('admin'));
      expectConforms('get', '/api/v1/organizational-units/{id}/history', 200, history.body);
      expect(history.body.data).toEqual([
        expect.objectContaining({ field: 'COLOR', oldValue: '#abcdef', newValue: null, source: 'MANUAL' }),
      ]);
      const vfHistory = await http().get(`/api/v1/organizational-units/${ids['u6']}/history`).set(auth('admin'));
      expect(vfHistory.body.data).toContainEqual(
        expect.objectContaining({ field: 'COLOR', oldValue: null, newValue: '#de9927', source: 'MANUAL' }),
      );
      const audited = await scalar<string>(
        dataSource,
        `SELECT changes->>'color' FROM audit_log WHERE entity_id = $1 AND action = 'ORG_UNIT_UPDATED' AND changes ? 'color'
         ORDER BY performed_at DESC LIMIT 1`,
        [ids['u6']],
      );
      expect(audited).toBe('#de9927');
    });

    it('Excel: exporta el Color; vacío conserva, NINGUNO quita, #RRGGBB cambia (con historial); inválido es error de fila', async () => {
      const file = await exportFile();
      const exported = new ExcelJS.Workbook();
      await exported.xlsx.load(file as unknown as ArrayBuffer);
      const sheet = exported.getWorksheet('Organigrama');
      if (!sheet) {
        throw new Error('falta la hoja');
      }
      const column = colorColumn(sheet);
      expect(String(rowByPrefix(sheet, '6').getCell(column).value)).toBe('#de9927');
      expect(rowByPrefix(sheet, '61').getCell(column).value ?? null).toBeNull();

      const invalid = await preview(
        await editExport(file, (edited) => {
          rowByPrefix(edited, '61').getCell(colorColumn(edited)).value = 'azul';
        }),
      );
      expect(invalid.status).toBe(201);
      expect(invalid.body.data.canConfirm).toBe(false);
      expect(invalid.body.data.errors).toEqual([
        expect.objectContaining({ column: 'Color', message: expect.stringContaining('«azul» no es un color') }),
      ]);

      const changed = await preview(
        await editExport(file, (edited) => {
          rowByPrefix(edited, '61').getCell(colorColumn(edited)).value = '#29B1B2';
          rowByPrefix(edited, '6').getCell(colorColumn(edited)).value = 'NINGUNO';
        }),
      );
      expect(changed.status, JSON.stringify(changed.body)).toBe(201);
      expectConforms('post', '/api/v1/organizational-units/import/preview', 201, changed.body);
      expect(changed.body.data.errors).toEqual([]);
      expect(changed.body.data.summary.units.colorChanged).toBe(2);
      expect(changed.body.data.changes.map((change: { kind: string; detail: string }) => [change.kind, change.detail])).toEqual(
        expect.arrayContaining([
          ['COLOR_CHANGED', 'Color quitado'],
          ['COLOR_CHANGED', 'Color: (sin color) → #29b1b2'],
        ]),
      );
      const applied = await confirm(changed.body.data.previewId as string);
      expect(applied.status, JSON.stringify(applied.body)).toBe(201);
      expect(await colorOf(ids['u6'])).toBeNull();
      expect(await colorOf(ids['u61'])).toBe('#29b1b2');
      const history = await http().get(`/api/v1/organizational-units/${ids['u61']}/history`).set(auth('admin'));
      expect(history.body.data).toContainEqual(
        expect.objectContaining({ field: 'COLOR', oldValue: null, newValue: '#29b1b2', source: 'IMPORT' }),
      );

      // Ida y vuelta: el archivo exportado ahora trae el color y no cambia nada.
      const again = await preview(await exportFile());
      expect(again.body.data.summary.totalChanges).toBe(0);

      // Archivo viejo sin la columna Color (y sello sin su huella): no toca colores ni da conflicto.
      const old = await editExport(await exportFile(), (edited) => {
        edited.spliceColumns(colorColumn(edited), 1);
        rowByPrefix(edited, '61').getCell(2).value = 'Departamento Excel sin columna Color';
      });
      const oldWorkbook = new ExcelJS.Workbook();
      await oldWorkbook.xlsx.load(old as unknown as ArrayBuffer);
      oldWorkbook.getWorksheet('_sello')?.getColumn(9).eachCell((cell) => {
        cell.value = null;
      });
      const oldPreview = await preview(Buffer.from(await oldWorkbook.xlsx.writeBuffer()));
      expect(oldPreview.status, JSON.stringify(oldPreview.body)).toBe(201);
      expect(oldPreview.body.data.errors).toEqual([]);
      expect(oldPreview.body.data.conflicts).toEqual([]);
      expect(oldPreview.body.data.changes.map((change: { kind: string }) => change.kind)).toEqual(['RENAMED']);
      expect(oldPreview.body.data.warnings.map((warning: { message: string }) => warning.message).join(' ')).not.toContain('sello');
      const oldApplied = await confirm(oldPreview.body.data.previewId as string);
      expect(oldApplied.status).toBe(201);
      expect(await colorOf(ids['u61'])).toBe('#29b1b2');
    });
  });

  describe('unidades con el mismo nombre', () => {
    const SAME = '¿Es otra unidad? Si es así, use un nombre que las distinga.';
    const create = (body: Record<string, unknown>) => http().post('/api/v1/organizational-units').set(auth('admin')).send(body);

    /** Archivo sin sello: solo el encabezado de un archivo exportado y las filas dadas. */
    const stamplessFile = async (rows: ReadonlyArray<ReadonlyArray<string | null>>): Promise<Buffer> => {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load((await exportFile()) as unknown as ArrayBuffer);
      const stamp = workbook.getWorksheet('_sello');
      if (stamp) {
        workbook.removeWorksheet(stamp.id);
      }
      const sheet = workbook.getWorksheet('Organigrama');
      if (!sheet) {
        throw new Error('falta la hoja');
      }
      sheet.spliceRows(2, sheet.rowCount - 1);
      rows.forEach((values, index) => {
        sheet.getRow(index + 2).values = [...values];
      });
      return Buffer.from(await workbook.xlsx.writeBuffer());
    };

    it('POST/PATCH: el nombre de una hermana activa (sin tildes ni mayúsculas) es solo una advertencia', async () => {
      // Jefe sin prefijo (en el Excel se nombra por su Código interno) y prefijos 97x: no tocan centros de otras pruebas.
      const rectorate = await create({ code: 'IT_OC_DIR', name: 'Dirección Excel', type: 'DEPARTMENT' });
      expect(rectorate.status, JSON.stringify(rectorate.body)).toBe(201);
      ids['dir'] = rectorate.body.data.id as string;
      const first = await create({ code: 'IT_OC_CAL_971', name: 'Calidad', type: 'OFFICE', parentId: ids['dir'], codePrefix: '971' });
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      expect(first.body.data.warnings).toEqual([]);

      const second = await create({ code: 'IT_OC_CAL_972', name: '  CALIDÁD ', type: 'OFFICE', parentId: ids['dir'], codePrefix: '972' });
      expect(second.status, JSON.stringify(second.body)).toBe(201);
      expectConforms('post', '/api/v1/organizational-units', 201, second.body);
      expect(second.body.data.warnings).toEqual([`Ya existe «Calidad» bajo Dirección Excel (prefijo 971). ${SAME}`]);
      ids['u33'] = second.body.data.id as string;
      expect(await scalar<number>(dataSource, 'SELECT count(*)::int FROM organizational_unit WHERE parent_id = $1', [ids['dir']])).toBe(2);

      // Editar otra cosa no repite el aviso; renombrar a donde hay otra igual, sí.
      const recolored = await http().patch(`/api/v1/organizational-units/${ids['u33']}`).set(auth('admin')).send({ color: '#29B1B2' });
      expect(recolored.status).toBe(200);
      expect(recolored.body.data.warnings).toEqual([]);
      const planning = await create({ code: 'IT_OC_PLA_973', name: 'Planeación', type: 'OFFICE', parentId: ids['dir'], codePrefix: '973' });
      expect(planning.body.data.warnings).toEqual([]);
      const planningId = planning.body.data.id as string;
      const renamed = await http().patch(`/api/v1/organizational-units/${planningId}`).set(auth('admin')).send({ name: 'calidad' });
      expect(renamed.status).toBe(200);
      expectConforms('patch', '/api/v1/organizational-units/{id}', 200, renamed.body);
      expect(renamed.body.data.warnings).toEqual([`Ya existe «Calidad» bajo Dirección Excel (prefijo 971). ${SAME}`]);
      const back = await http().patch(`/api/v1/organizational-units/${planningId}`).set(auth('admin')).send({ name: 'Planeación' });
      expect(back.body.data.warnings).toEqual([]);
    });

    it('Excel: fila nueva sin prefijo con el nombre de una hermana es error de fila; con prefijo nuevo, advertencia', async () => {
      const file = await editExport(await exportFile(), (sheet) => {
        sheet.getRow(sheet.rowCount + 1).values = ['', 'calidad', 'Oficina', 'IT_OC_DIR'];
        sheet.getRow(sheet.rowCount + 1).values = ['974', 'Calidad', 'Oficina', 'IT_OC_DIR'];
      });
      const previewed = await preview(file);
      expect(previewed.status, JSON.stringify(previewed.body)).toBe(201);
      expectConforms('post', '/api/v1/organizational-units/import/preview', 201, previewed.body);
      const data = previewed.body.data;
      expect(data.canConfirm).toBe(false);
      expect(data.errors).toEqual([
        expect.objectContaining({
          column: 'Nombre',
          message: expect.stringMatching(
            /^Ya existe «Calidad» bajo Dirección Excel \(prefijo 971, creada el \d{2}\/\d{2}\/\d{4}[^)]*\)\. Si es la misma, copie su Código interno \(IT_OC_CAL_971\) en la fila; si es otra, escriba su prefijo o un nombre distinto\./,
          ),
        }),
      ]);
      expect(data.warnings).toContainEqual(
        expect.objectContaining({ column: 'Nombre', message: `Ya existe «Calidad» bajo Dirección Excel (prefijo 971). ${SAME}` }),
      );
      expect(data.changes).toEqual([expect.objectContaining({ kind: 'CREATED', code: '974' })]);
      expect((await confirm(data.previewId as string)).status).toBe(422);
    });

    it('Excel sin sello subido dos veces con una fila nueva sin prefijo: la segunda vez es error, no duplica', async () => {
      const file = await stamplessFile([[null, 'Oficina Gemela', 'Oficina', 'IT_OC_DIR']]);
      const first = await preview(file);
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      expect(first.body.data.errors).toEqual([]);
      expect(first.body.data.summary.units.created).toBe(1);
      expect((await confirm(first.body.data.previewId as string)).status).toBe(201);

      const again = await preview(file);
      expect(again.status).toBe(201);
      expectConforms('post', '/api/v1/organizational-units/import/preview', 201, again.body);
      expect(again.body.data).toMatchObject({ canConfirm: false, fileAppliedBefore: { at: expect.any(String) } });
      expect(again.body.data.warnings[0]).toMatchObject({ rowNumber: 1, message: expect.stringMatching(/^Este archivo ya se aplicó el /) });
      expect(again.body.data.errors).toEqual([
        expect.objectContaining({
          rowNumber: 2,
          column: 'Nombre',
          message: expect.stringContaining('Ya existe «Oficina Gemela» bajo Dirección Excel (creada el '),
        }),
      ]);
      expect(again.body.data.summary.totalChanges).toBe(0);
      expect(await scalar<number>(dataSource, "SELECT count(*)::int FROM organizational_unit WHERE name = 'Oficina Gemela'")).toBe(1);

      // Dos filas nuevas iguales en el mismo archivo: error en la segunda.
      const doubled = await preview(
        await stamplessFile([
          [null, 'Oficina Nueva Doble', 'Oficina', 'IT_OC_DIR'],
          [null, 'OFICINA NUEVA DOBLE', 'Oficina', 'IT_OC_DIR'],
        ]),
      );
      expect(doubled.body.data.errors).toEqual([
        {
          sheet: 'Organigrama',
          rowNumber: 3,
          column: 'Nombre',
          message:
            'La fila 2 ya crea «Oficina Nueva Doble» bajo Dirección Excel. Si es la misma unidad, borre esta fila; si es otra, escriba su prefijo o un nombre distinto.',
        },
      ]);
    });
  });
});
