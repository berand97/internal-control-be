import type { NestExpressApplication } from '@nestjs/platform-express';
import { SchedulerRegistry } from '@nestjs/schedule';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { createAppValidationPipe } from '../../src/common/pipes/app-validation.pipe.js';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';
import { TokenService } from '../../src/modules/auth/services/token.service.js';
import { createActor, createPermissionRole, openTestSession, scalar } from './helpers.js';
import { conform, type Schema } from './openapi-conform.js';

describe('Detalle de unidad: centros de costo con jefe y activos (HTTP real + PostgreSQL real)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let openapi: OpenAPIObject;
  const tag = randomUUID().slice(0, 6).toUpperCase();
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const route = '/api/v1/organizational-units/{id}/cost-centers';

  const http = () => request(app.getHttpServer());
  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who] ?? ''}` });
  const centersOf = (unitKey: string, who = 'reader') =>
    http().get(`/api/v1/organizational-units/${ids[unitKey] ?? randomUUID()}/cost-centers`).set(auth(who));

  const expectConforms = (method: string, path: string, status: number, body: unknown) => {
    const operation = (
      openapi.paths[path] as Record<string, { responses: Record<string, { content?: Record<string, { schema: Schema }> }> }>
    )[method];
    const schema = operation?.responses[String(status)]?.content?.['application/json']?.schema;
    expect(schema, `${method.toUpperCase()} ${path} ${status} no declara esquema`).toBeDefined();
    const errors: string[] = [];
    conform(openapi, body, schema ?? {}, `${method.toUpperCase()} ${path}`, errors);
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
  };

  const insertCenter = async (key: string, unitKey: string, options: { active?: boolean; acceptsAssets?: boolean } = {}) => {
    ids[key] = await scalar<string>(
      dataSource,
      `INSERT INTO cost_center (external_code, name, organizational_unit_id, accepts_assets, is_active, sync_source, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'MANUAL', NOW(), NOW()) RETURNING id`,
      [`OD${tag}${key}`, `Centro ${key} ${tag}`, ids[unitKey], options.acceptsAssets ?? true, options.active ?? true],
    );
  };

  const insertPerson = (first: string, last: string) =>
    scalar<string>(
      dataSource,
      `INSERT INTO person (first_name, last_name, email, document_type, document_number) VALUES ($1, $2, $3, 'CC', $4) RETURNING id`,
      [first, last, `detalle.${randomUUID().slice(0, 8)}@unac.edu.co`, `8${Date.now().toString().slice(-7)}${Math.floor(Math.random() * 100)}`],
    );

  const insertHead = (personId: string, centerKey: string, validUntil: string | null) =>
    dataSource.query(
      `INSERT INTO cost_center_head (person_id, cost_center_id, valid_from, valid_until, reason, ended_at, ended_by, end_reason)
       VALUES ($1, $2, '2000-01-01', $3::timestamptz, 'Prueba detalle', $3::timestamptz, NULL,
               CASE WHEN $3::timestamptz IS NULL THEN NULL ELSE 'Terminó' END)`,
      [personId, ids[centerKey], validUntil],
    );

  const insertAsset = async (centerKey: string, status: 'IN_USE' | 'WRITTEN_OFF') => {
    const suffix = randomUUID().slice(0, 8).toUpperCase();
    await dataSource.query(
      `INSERT INTO asset (internal_code, description, category_id, acquisition_type_id, acquisition_date, acquisition_price,
         current_cost_center_id, created_by, physical_condition, operational_status, written_off_at)
       VALUES ($1, 'Equipo detalle', $2, (SELECT id FROM acquisition_type WHERE code = 'PURCHASE'), '2023-01-10', 1000,
               $3, $4, 'GOOD', $5, $6::timestamptz)`,
      [`ODA${suffix}`, ids['category'], ids[centerKey], ids['adminUser'], status, status === 'WRITTEN_OFF' ? new Date() : null],
    );
  };

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
    ids['adminUser'] = admin.id;

    const reader = await createActor(dataSource);
    await grant(reader.id, await createPermissionRole(dataSource, ['org_unit:read:global'], 'IT_SOLO_UNIDADES'));
    tokens['reader'] = await token(reader);

    const outsider = await createActor(dataSource);
    await grant(outsider.id, await createPermissionRole(dataSource, ['cost_center:read:global'], 'IT_SIN_UNIDADES'));
    tokens['outsider'] = await token(outsider);

    ids['category'] = await scalar<string>(
      dataSource,
      `INSERT INTO asset_category (code, name, requires_photo) VALUES ($1, 'Detalle unidad', FALSE) RETURNING id`,
      [`OD_${tag}`],
    );

    await createUnit('vf', { code: `IT_OD_VF_${tag}`, name: `Vicerrectoría Detalle ${tag}`, type: 'VICERECTORATE' });
    await createUnit('cont', { code: `IT_OD_CONT_${tag}`, name: `Contabilidad Detalle ${tag}`, type: 'DEPARTMENT', parentId: ids['vf'] });

    await insertCenter('2', 'vf', { acceptsAssets: false });
    await insertCenter('1', 'vf');
    await insertCenter('3', 'vf');
    await insertCenter('9', 'vf', { active: false });
    await insertCenter('5', 'cont');

    ids['headPerson'] = await insertPerson('Ana María', `Pérez ${tag}`);
    await insertHead(ids['headPerson'], '1', null);
    await insertHead(await insertPerson('Antiguo', `Jefe ${tag}`), '3', '2001-01-01');
    await insertHead(await insertPerson('Jefe', `Hija ${tag}`), '5', null);

    await insertAsset('1', 'IN_USE');
    await insertAsset('1', 'IN_USE');
    await insertAsset('1', 'WRITTEN_OFF');
    await insertAsset('3', 'WRITTEN_OFF');
    await insertAsset('5', 'IN_USE');
  });

  afterAll(async () => {
    await app.close();
  });

  it('lista solo los centros activos directos, por código, con jefe vigente o null y activos sin dados de baja', async () => {
    const response = await centersOf('vf');
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expectConforms('get', route, 200, response.body);
    expect(response.body.data).toEqual([
      {
        id: ids['1'],
        code: `OD${tag}1`,
        name: `Centro 1 ${tag}`,
        acceptsAssets: true,
        currentHead: { personId: ids['headPerson'], fullName: `Ana María Pérez ${tag}` },
        assetCount: 2,
      },
      { id: ids['2'], code: `OD${tag}2`, name: `Centro 2 ${tag}`, acceptsAssets: false, currentHead: null, assetCount: 0 },
      { id: ids['3'], code: `OD${tag}3`, name: `Centro 3 ${tag}`, acceptsAssets: true, currentHead: null, assetCount: 0 },
    ]);
    expect(JSON.stringify(response.body)).not.toMatch(/document|email|@unac/i);
  });

  it('la unidad hija lista los suyos y una unidad archivada sigue respondiendo con sus centros', async () => {
    const child = await centersOf('cont');
    expect(child.status).toBe(200);
    expect(child.body.data.map((center: { id: string }) => center.id)).toEqual([ids['5']]);
    expect(child.body.data[0]).toMatchObject({ assetCount: 1, currentHead: { fullName: `Jefe Hija ${tag}` } });

    await dataSource.query('UPDATE organizational_unit SET is_active = FALSE WHERE id = $1', [ids['cont']]);
    const archived = await centersOf('cont');
    expect(archived.status).toBe(200);
    expect(archived.body.data.map((center: { id: string }) => center.id)).toEqual([ids['5']]);
    await dataSource.query('UPDATE organizational_unit SET is_active = TRUE WHERE id = $1', [ids['cont']]);
  });

  it('404 con el error de no encontrado si la unidad no existe', async () => {
    const response = await centersOf('nope');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('RESOURCE_NOT_FOUND');
    expect(Object.keys(openapi.paths[route]?.get?.responses ?? {})).toEqual(expect.arrayContaining(['200', '404']));
  });

  it('permiso: con solo org_unit:read:global responde; sin él, 403', async () => {
    expect((await centersOf('vf', 'reader')).status).toBe(200);
    const denied = await centersOf('vf', 'outsider');
    expect(denied.status).toBe(403);
  });

  it('el detalle trae lo que pinta la pantalla, con el nombre del padre', async () => {
    const child = await http().get(`/api/v1/organizational-units/${ids['cont']}`).set(auth('reader'));
    expect(child.status).toBe(200);
    expectConforms('get', '/api/v1/organizational-units/{id}', 200, child.body);
    expect(child.body.data).toMatchObject({
      id: ids['cont'],
      name: `Contabilidad Detalle ${tag}`,
      code: `IT_OD_CONT_${tag}`,
      type: 'DEPARTMENT',
      parentId: ids['vf'],
      parentName: `Vicerrectoría Detalle ${tag}`,
      codePrefix: null,
      headCostCenterCode: null,
      headCostCenterPending: false,
      color: null,
      isActive: true,
    });
    const root = await http().get(`/api/v1/organizational-units/${ids['vf']}`).set(auth('reader'));
    expect(root.body.data).toMatchObject({ parentId: null, parentName: null });
  });
});
