// Conciliador de estructura (organigrama ↔ centros de costo) con HTTP real + PostgreSQL real: centro propio pendiente
// que se amarra al crear el centro, reubicación por prefijo más largo, ubicación MANUAL respetada, vista previa y
// aplicación de «Recalcular estructura», pendientes, vuelta a automático y unidad movida a otro jefe con advertencia.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SchedulerRegistry } from '@nestjs/schedule';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { createAppValidationPipe } from '../../src/common/pipes/app-validation.pipe.js';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';
import { TokenService } from '../../src/modules/auth/services/token.service.js';
import { createActor, openTestSession } from './helpers.js';
import { conform, type Schema } from './openapi-conform.js';

describe('Conciliador de estructura (HTTP real + PostgreSQL real)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let openapi: OpenAPIObject;
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

  const createUnit = async (key: string, body: Record<string, unknown>) => {
    const response = await http().post('/api/v1/organizational-units').set(auth('admin')).send(body);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    ids[key] = response.body.data.id as string;
    return response;
  };

  const createCenter = async (code: string, body: Record<string, unknown> = {}) => {
    const response = await http()
      .post('/api/v1/cost-centers')
      .set(auth('admin'))
      .send({ externalCode: code, name: `CENTRO ${code}`, ...body });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    ids[code] = response.body.data.id as string;
    return response;
  };

  const center = async (code: string) =>
    (
      (await dataSource.query(
        `SELECT cc.id, cc.organizational_unit_id, cc.parent_id, p.mode, p.source, p.reason
         FROM cost_center cc JOIN cost_center_placement p ON p.cost_center_id = cc.id AND p.valid_until IS NULL
         WHERE cc.external_code = $1`,
        [code],
      )) as Array<{ id: string; organizational_unit_id: string | null; parent_id: string | null; mode: string; source: string; reason: string }>
    )[0];

  const unitRow = async (key: string) =>
    (
      (await dataSource.query('SELECT head_cost_center_id, head_cost_center_code FROM organizational_unit WHERE id = $1', [
        ids[key],
      ])) as Array<{ head_cost_center_id: string | null; head_cost_center_code: string | null }>
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
    const admin = await createActor(dataSource);
    await grant(admin.id, 'INTERNAL_CONTROL_DIRECTOR');
    tokens['admin'] = await token(admin);
    const reader = await createActor(dataSource);
    await grant(reader.id, 'AUDITOR');
    tokens['reader'] = await token(reader);
  });

  afterAll(async () => {
    await app.close();
  });

  it('unidad con centro propio pendiente → crear el centro lo amarra, lo reubica y queda en el histórico', async () => {
    await createUnit('u5', { code: 'IT_RC_TRES', name: 'Vicerrectoría Recalcular', type: 'VICERECTORATE', codePrefix: '5' });
    const pending = await createUnit('u54', {
      code: 'IT_RC_TREINTAYCUATRO',
      name: 'Departamento Recalcular',
      type: 'DEPARTMENT',
      codePrefix: '54',
      parentId: ids['u5'],
      headCostCenterCode: '5410',
    });
    expect(pending.body.data).toMatchObject({
      headCostCenterId: null,
      headCostCenterCode: '5410',
      headCostCenterPending: true,
      warnings: ['Centro propio 5410 pendiente: el centro aún no existe; se amarrará solo cuando se cree'],
    });
    expectConforms('post', '/api/v1/organizational-units', 201, pending.body);

    // Se crea en la vicerrectoría 5: el código manda (prefijo más largo, 54).
    await createCenter('5410', { organizationalUnitId: ids['u5'] });
    expect(await center('5410')).toMatchObject({ organizational_unit_id: ids['u54'], mode: 'AUTO', source: 'AUTO' });
    expect((await center('5410'))?.reason).toBe('Se creó el centro 5410');
    expect(await unitRow('u54')).toEqual({ head_cost_center_id: ids['5410'], head_cost_center_code: '5410' });
    const history = (await dataSource.query(
      `SELECT old_value, new_value, source, reason FROM org_structure_history
       WHERE entity_id = $1 AND field = 'HEAD_COST_CENTER' ORDER BY changed_at DESC LIMIT 1`,
      [ids['u54']],
    )) as Array<{ old_value: string; new_value: string; source: string; reason: string }>;
    expect(history[0]).toEqual({ old_value: '5410 (pendiente)', new_value: '5410', source: 'AUTO', reason: 'Se creó el centro 5410' });
    const unit = await http().get(`/api/v1/organizational-units/${ids['u54']}`).set(auth('admin'));
    expect(unit.body.data).toMatchObject({ headCostCenterId: ids['5410'], headCostCenterPending: false });

    // Hijo XYZn: unidad por prefijo y padre XYZ0 por regla.
    await createCenter('5411', { organizationalUnitId: ids['u5'] });
    expect(await center('5411')).toMatchObject({ organizational_unit_id: ids['u54'], parent_id: ids['5410'] });
  });

  it('ubicación MANUAL: no se toca y aparece como excepción; placement/auto la devuelve', async () => {
    const moved = await http()
      .post(`/api/v1/cost-centers/${ids['5411']}/placement`)
      .set(auth('admin'))
      .send({ organizationalUnitId: ids['u5'], reason: 'Decisión de Contabilidad' });
    expect(moved.status, JSON.stringify(moved.body)).toBe(201);
    expect(moved.body.data).toMatchObject({ mode: 'MANUAL', source: 'MANUAL' });

    const preview = await http().get('/api/v1/organizational-units/reconcile/preview').set(auth('admin'));
    expect(preview.status).toBe(200);
    expectConforms('get', '/api/v1/organizational-units/reconcile/preview', 200, preview.body);
    expect(preview.body.data.manualExceptions).toContainEqual(
      expect.objectContaining({ reason: 'MANUAL', center: expect.objectContaining({ externalCode: '5411' }) }),
    );
    expect(preview.body.data.relocations.map((item: { center: { externalCode: string } }) => item.center.externalCode)).not.toContain('5411');

    const pendingList = await http().get('/api/v1/organizational-units/structure-pending').set(auth('reader'));
    expect(pendingList.status).toBe(200);
    expectConforms('get', '/api/v1/organizational-units/structure-pending', 200, pendingList.body);
    expect(pendingList.body.data.manualExceptions).toContainEqual(
      expect.objectContaining({ center: expect.objectContaining({ externalCode: '5411' }) }),
    );

    const back = await http().post(`/api/v1/cost-centers/${ids['5411']}/placement/auto`).set(auth('admin'));
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expectConforms('post', '/api/v1/cost-centers/{id}/placement/auto', 200, back.body);
    expect(back.body.data.counts.relocations).toBe(1);
    expect(await center('5411')).toMatchObject({ organizational_unit_id: ids['u54'], mode: 'AUTO', source: 'AUTO' });
  });

  it('Recalcular estructura: vista previa, 409 si cambió, aplicar e idempotencia', async () => {
    // Un centro que entró por fuera de la aplicación (sin conciliar).
    await dataSource.query(
      `INSERT INTO cost_center (external_code, name, organizational_unit_id, accepts_assets, is_active, sync_source, created_at, updated_at)
       VALUES ('5420', 'CENTRO 5420', $1, TRUE, TRUE, 'MANUAL', NOW(), NOW())`,
      [ids['u5']],
    );
    const denied = await http().get('/api/v1/organizational-units/reconcile/preview').set(auth('reader'));
    expect(denied.status).toBe(403);
    const preview = await http().get('/api/v1/organizational-units/reconcile/preview').set(auth('admin'));
    expect(preview.body.data.relocations).toContainEqual(
      expect.objectContaining({
        center: expect.objectContaining({ externalCode: '5420' }),
        toUnit: expect.objectContaining({ id: ids['u54'], codePrefix: '54' }),
      }),
    );
    const stale = await http()
      .post('/api/v1/organizational-units/reconcile')
      .set(auth('admin'))
      .send({ expectedHash: '0'.repeat(64) });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STRUCTURE_RECONCILE_STALE');

    const applied = await http()
      .post('/api/v1/organizational-units/reconcile')
      .set(auth('admin'))
      .send({ expectedHash: preview.body.data.hash });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expectConforms('post', '/api/v1/organizational-units/reconcile', 200, applied.body);
    expect(applied.body.data.counts.relocations).toBeGreaterThanOrEqual(1);
    expect(await center('5420')).toMatchObject({ organizational_unit_id: ids['u54'], source: 'AUTO', reason: 'Recalcular estructura' });
    const audits = (await dataSource.query(
      `SELECT changes FROM audit_log WHERE action = 'STRUCTURE_RECONCILED' ORDER BY performed_at DESC LIMIT 1`,
    )) as Array<{ changes: { reason: string; counts: Record<string, number> } }>;
    expect(audits[0]?.changes).toMatchObject({ reason: 'Recalcular estructura' });

    const again = await http().post('/api/v1/organizational-units/reconcile').set(auth('admin')).send({});
    expect(again.status).toBe(200);
    expect(again.body.data.counts).toMatchObject({ relocations: 0, reparents: 0, headLinks: 0, headUnlinks: 0 });
  });

  it('Control Interno movido a otro jefe conserva sus códigos: advertencia, centro en su unidad, histórico de padre', async () => {
    await createUnit('u2', { code: 'IT_RC_DOS', name: 'Rectoría Recalcular', type: 'RECTORATE', codePrefix: '2' });
    await createUnit('u542', {
      code: 'IT_RC_CONTROL',
      name: 'Control Interno Recalcular',
      type: 'OFFICE',
      codePrefix: '542',
      parentId: ids['u54'],
    });
    expect(await center('5420')).toMatchObject({ organizational_unit_id: ids['u542'] });
    const moved = await http().patch(`/api/v1/organizational-units/${ids['u542']}`).set(auth('admin')).send({ parentId: ids['u2'] });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expectConforms('patch', '/api/v1/organizational-units/{id}', 200, moved.body);
    expect(moved.body.data.warnings).toEqual([
      'Control Interno Recalcular (542) depende de Rectoría Recalcular (2) pero conserva los códigos 542… de Departamento Recalcular',
    ]);
    expect(await center('5420')).toMatchObject({ organizational_unit_id: ids['u542'] });
    const parentEvents = (await dataSource.query(
      `SELECT new_value FROM org_structure_history WHERE entity_id = $1 AND field = 'PARENT'`,
      [ids['u542']],
    )) as Array<{ new_value: string }>;
    expect(parentEvents.map((row) => row.new_value)).toContain('2 · Rectoría Recalcular');
  });

  it('archivar el centro propio deja la unidad pendiente; structure-pending la lista', async () => {
    const archived = await http().patch(`/api/v1/cost-centers/${ids['5410']}`).set(auth('admin')).send({ isActive: false });
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);
    expect(await unitRow('u54')).toEqual({ head_cost_center_id: null, head_cost_center_code: '5410' });
    // 5411 pierde su padre 5410 (archivado): cuelga de su unidad.
    expect(await center('5411')).toMatchObject({ parent_id: null });
    const pendingList = await http().get('/api/v1/organizational-units/structure-pending').set(auth('admin'));
    expect(pendingList.body.data.pendingHeadCenters).toContainEqual({
      unitId: ids['u54'],
      unitName: 'Departamento Recalcular',
      prefix: '54',
      code: '5410',
    });
    const reactivated = await http().patch(`/api/v1/cost-centers/${ids['5410']}`).set(auth('admin')).send({ isActive: true });
    expect(reactivated.status).toBe(200);
    expect(await unitRow('u54')).toEqual({ head_cost_center_id: ids['5410'], head_cost_center_code: '5410' });
    expect(await center('5411')).toMatchObject({ parent_id: ids['5410'] });
  });
});
