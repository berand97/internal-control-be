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

describe('Unidades archivadas: nunca son padre (HTTP real + PostgreSQL real)', () => {
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

  const insertCenter = async (code: string, unitKey: string) => {
    const [row] = (await dataSource.query(
      `INSERT INTO cost_center (external_code, name, organizational_unit_id, accepts_assets, is_active, sync_source, created_at, updated_at)
       VALUES ($1, $2, $3, TRUE, TRUE, 'MANUAL', NOW(), NOW()) RETURNING id`,
      [code, `CENTRO ${code}`, ids[unitKey]],
    )) as Array<{ id: string }>;
    ids[code] = row?.id ?? '';
  };

  const patchUnit = (key: string, body: Record<string, unknown>) =>
    http().patch(`/api/v1/organizational-units/${ids[key]}`).set(auth('admin')).send(body);

  const isActive = async (key: string) =>
    (
      (await dataSource.query('SELECT is_active FROM organizational_unit WHERE id = $1', [ids[key]])) as Array<{
        is_active: boolean;
      }>
    )[0]?.is_active;

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

    await createUnit('vf', { code: 'IT_OA_VF', name: 'Vicerrectoría Archivo', type: 'VICERECTORATE' });
    await createUnit('cont', { code: 'IT_OA_CONT', name: 'Contabilidad Archivo', type: 'DEPARTMENT', parentId: ids['vf'] });
    await createUnit('otra', { code: 'IT_OA_OTRA', name: 'Otra Archivo', type: 'DEPARTMENT' });
    await insertCenter('9710', 'vf');
  });

  afterAll(async () => {
    await app.close();
  });

  it('archivar por PATCH aplica las reglas de DELETE: hijas activas y centros activos con conteos', async () => {
    const withChild = await patchUnit('vf', { isActive: false });
    expect(withChild.status).toBe(406);
    expect(withChild.body.error).toMatchObject({
      code: 'ORG_UNIT_HAS_CHILDREN',
      details: [{ field: 'activeChildren', message: '1' }],
    });

    const childArchived = await patchUnit('cont', { isActive: false });
    expect(childArchived.status, JSON.stringify(childArchived.body)).toBe(200);

    const withCenter = await patchUnit('vf', { isActive: false });
    expect(withCenter.status).toBe(406);
    expect(withCenter.body.error).toMatchObject({
      code: 'HAS_DEPENDENT_ENTITIES',
      details: [{ field: 'activeCostCenters', message: '1' }],
    });
    expect(await isActive('vf')).toBe(true);

    await dataSource.query('UPDATE cost_center SET is_active = FALSE WHERE id = $1', [ids['9710']]);
    const archived = await patchUnit('vf', { isActive: false });
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);
    expectConforms('patch', '/api/v1/organizational-units/{id}', 200, archived.body);
    expect(archived.body.data).not.toHaveProperty('archivedChildUnits');
    expect(await isActive('vf')).toBe(false);
  });

  it('una unidad archivada no puede ser padre: crear, mover y reactivar la hija responden 409', async () => {
    const created = await http()
      .post('/api/v1/organizational-units')
      .set(auth('admin'))
      .send({ code: 'IT_OA_NUEVA', name: 'Nueva Archivo', type: 'DEPARTMENT', parentId: ids['vf'] });
    expect(created.status).toBe(409);
    expect(Object.keys(openapi.paths['/api/v1/organizational-units']?.post?.responses ?? {})).toContain('409');
    expect(created.body.error).toMatchObject({
      code: 'ORG_UNIT_PARENT_ARCHIVED',
      message: 'La dependencia «Vicerrectoría Archivo» está archivada. Reactívela primero o elija otro padre.',
      details: [{ field: 'parentId', message: ids['vf'] }],
    });

    const moved = await patchUnit('otra', { parentId: ids['vf'] });
    expect(moved.status).toBe(409);
    expect(Object.keys(openapi.paths['/api/v1/organizational-units/{id}']?.patch?.responses ?? {})).toEqual(
      expect.arrayContaining(['406', '409']),
    );
    expect(moved.body.error.code).toBe('ORG_UNIT_PARENT_ARCHIVED');

    const child = await patchUnit('cont', { isActive: true });
    expect(child.status).toBe(409);
    expect(child.body.error.code).toBe('ORG_UNIT_PARENT_ARCHIVED');
    expect(await isActive('cont')).toBe(false);

    const toRoot = await patchUnit('otra', { parentId: null });
    expect(toRoot.status, JSON.stringify(toRoot.body)).toBe(200);
  });

  it('reactivar reactiva solo la unidad y dice cuántas hijas y centros siguen archivados', async () => {
    const reactivated = await patchUnit('vf', { isActive: true });
    expect(reactivated.status, JSON.stringify(reactivated.body)).toBe(200);
    expectConforms('patch', '/api/v1/organizational-units/{id}', 200, reactivated.body);
    expect(reactivated.body.data).toMatchObject({
      isActive: true,
      archivedChildUnits: 1,
      archivedCostCenters: 1,
      warnings: [],
      warningDetails: [],
    });
    expect(await isActive('cont')).toBe(false);
    const [center] = (await dataSource.query('SELECT is_active FROM cost_center WHERE id = $1', [ids['9710']])) as Array<{
      is_active: boolean;
    }>;
    expect(center?.is_active).toBe(false);

    const child = await patchUnit('cont', { isActive: true });
    expect(child.status, JSON.stringify(child.body)).toBe(200);
    expect(child.body.data).toMatchObject({ archivedChildUnits: 0, archivedCostCenters: 0 });
  });

  it('structure-pending lista los datos viejos inconsistentes sin corregirlos', async () => {
    await createUnit('legacy', { code: 'IT_OA_LEGADO', name: 'Legado Archivo', type: 'OFFICE' });
    await createUnit('legacyChild', { code: 'IT_OA_LEGADO_HIJA', name: 'Hija Legado', type: 'DEPARTMENT', parentId: ids['legacy'] });
    await insertCenter('9720', 'legacy');
    await dataSource.query('UPDATE organizational_unit SET is_active = FALSE WHERE id = $1', [ids['legacy']]);

    const pending = await http().get('/api/v1/organizational-units/structure-pending').set(auth('admin'));
    expect(pending.status).toBe(200);
    expectConforms('get', '/api/v1/organizational-units/structure-pending', 200, pending.body);
    expect(pending.body.data.unitsUnderArchivedParent).toEqual([
      {
        id: ids['legacyChild'],
        code: 'IT_OA_LEGADO_HIJA',
        name: 'Hija Legado',
        codePrefix: null,
        parentId: ids['legacy'],
        parentName: 'Legado Archivo',
      },
    ]);
    expect(pending.body.data.centersInArchivedUnit).toEqual([
      { id: ids['9720'], code: '9720', name: 'CENTRO 9720', unitId: ids['legacy'], unitName: 'Legado Archivo' },
    ]);
    expect(await isActive('legacyChild')).toBe(true);

    const renamed = await patchUnit('legacyChild', { name: 'Hija Legado Renombrada' });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
  });
});
