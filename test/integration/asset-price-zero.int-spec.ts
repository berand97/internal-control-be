import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { createAppValidationPipe } from '../../src/common/pipes/app-validation.pipe.js';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';
import { AssetsService } from '../../src/modules/assets/services/assets.service.js';
import { TokenService } from '../../src/modules/auth/services/token.service.js';
import { createActor, openTestSession, scalar } from './helpers.js';
import { conform, type Schema } from './openapi-conform.js';

interface PriceZeroRow {
  id: string;
  internalCode: string;
  costCenter: { id: string } | null;
  reason: { id: string; label: string } | null;
  note: string | null;
  classifiedBy: { userId: string } | null;
}

interface PriceZeroList {
  items: PriceZeroRow[];
  total: number;
  hasNext: boolean;
  summary: { total: number; classified: number; unclassified: number };
}

/**
 * Activos con precio de compra cero: marca PRICE_ZERO (importación, alta y trigger), catálogo de motivos que nace vacío,
 * lista de trabajo con el alcance de lectura de activos y registro del motivo sin tocar el precio. PostgreSQL real y
 * HTTP, con las respuestas comparadas contra el OpenAPI publicado.
 */
describe('Activos con precio cero: marca, catálogo de motivos y lista de trabajo (PostgreSQL real)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let openapi: OpenAPIObject;
  let director: AuthenticatedUser;
  let centerA: string;
  let centerB: string;
  let categoryId: string;
  let acquisitionTypeId: string;
  const tokens: Record<string, string> = {};

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

  const userWith = async (name: string, role: string, scopeType: 'GLOBAL' | 'COST_CENTER', scopeId: string | null = null) => {
    const user = await createActor(dataSource);
    await dataSource.query(
      `INSERT INTO user_role (user_id, role_id, scope_type, scope_id) SELECT $1, id, $2, $3 FROM role WHERE code = $4`,
      [user.id, scopeType, scopeId, role],
    );
    tokens[name] = app.get(TokenService).signAccessToken({ ...user, sessionId: await openTestSession(dataSource, user.id) });
    return user;
  };

  const rawAsset = async (costCenterId: string, price: number, flags: string[] = []) =>
    scalar<string>(
      dataSource,
      `INSERT INTO asset (internal_code, description, category_id, acquisition_type_id, acquisition_date, acquisition_price,
         current_cost_center_id, created_by, data_quality_flags)
       VALUES ($1, 'Activo precio cero', $2, $3, '2020-01-01', $4, $5, $6, $7) RETURNING id`,
      [`PZ-${randomUUID().slice(0, 8)}`, categoryId, acquisitionTypeId, price, costCenterId, director.id, flags],
    );

  const flagsOf = (id: string) => scalar<string[]>(dataSource, 'SELECT data_quality_flags FROM asset WHERE id = $1', [id]);

  const list = async (who: string, query: Record<string, string | number | boolean> = {}) => {
    const response = await http().get('/api/v1/assets/price-zero').query(query).set(auth(who));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expectConforms('get', '/api/v1/assets/price-zero', 200, response.body);
    return response.body.data as PriceZeroList;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
    dataSource = app.get(DataSource);
    openapi = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    const tag = randomUUID().slice(0, 6);
    centerA = await scalar<string>(dataSource, `INSERT INTO cost_center (external_code, name) VALUES ($1, 'Centro A') RETURNING id`, [
      `PZA-${tag}`,
    ]);
    centerB = await scalar<string>(dataSource, `INSERT INTO cost_center (external_code, name) VALUES ($1, 'Centro B') RETURNING id`, [
      `PZB-${tag}`,
    ]);
    categoryId = await scalar<string>(
      dataSource,
      `INSERT INTO asset_category (code, name, requires_photo) VALUES ($1, 'Categoría precio cero', FALSE) RETURNING id`,
      [`PZ_${tag}`],
    );
    acquisitionTypeId = await scalar<string>(dataSource, `SELECT id FROM acquisition_type WHERE code = 'PURCHASE'`);
    director = await userWith('director', 'INTERNAL_CONTROL_DIRECTOR', 'GLOBAL');
    await userWith('viewerA', 'VIEWER', 'COST_CENTER', centerA);
  });

  afterAll(async () => {
    await app.close();
  });

  it('el catálogo de motivos nace vacío y solo quien tiene el permiso de gestión lo administra', async () => {
    expect(await scalar<number>(dataSource, 'SELECT count(*)::int FROM asset_price_zero_reason')).toBe(0);
    const empty = await http().get('/api/v1/assets/price-zero-reasons').set(auth('viewerA')).expect(200);
    expectConforms('get', '/api/v1/assets/price-zero-reasons', 200, empty.body);
    expect(empty.body.data).toEqual([]);
    // Sembrado solo a la Dirección de Control Interno.
    expect(
      await scalar<string[]>(
        dataSource,
        `SELECT array_agg(r.code ORDER BY r.code) FROM role_permission rp JOIN role r ON r.id = rp.role_id
         JOIN permission p ON p.id = rp.permission_id WHERE p.code = 'asset_price_zero_reason:manage:global'`,
      ),
    ).toEqual(['INTERNAL_CONTROL_DIRECTOR']);

    const denied = await http().post('/api/v1/assets/price-zero-reasons').set(auth('viewerA')).send({ label: 'Donación' });
    expect(denied.status).toBe(403);
    const created = await http().post('/api/v1/assets/price-zero-reasons').set(auth('director')).send({ label: 'Donación sin avalúo' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expectConforms('post', '/api/v1/assets/price-zero-reasons', 201, created.body);
    expect(created.body.data).toMatchObject({ label: 'Donación sin avalúo', isActive: true, inUse: false });
    const duplicated = await http().post('/api/v1/assets/price-zero-reasons').set(auth('director')).send({ label: ' donación SIN avalúo ' });
    expect([duplicated.status, duplicated.body.error.code]).toEqual([406, 'ASSET_PRICE_ZERO_REASON_EXISTS']);
    const updated = await http()
      .patch(`/api/v1/assets/price-zero-reasons/${created.body.data.id as string}`)
      .set(auth('director'))
      .send({ sortOrder: 5 });
    expect(updated.status).toBe(200);
    expectConforms('patch', '/api/v1/assets/price-zero-reasons/{id}', 200, updated.body);
    const spare = await http().post('/api/v1/assets/price-zero-reasons').set(auth('director')).send({ label: 'Motivo de prueba' });
    const deleted = await http().delete(`/api/v1/assets/price-zero-reasons/${spare.body.data.id as string}`).set(auth('director'));
    expect(deleted.status).toBe(200);
    expectConforms('delete', '/api/v1/assets/price-zero-reasons/{id}', 200, deleted.body);
  });

  it('marca PRICE_ZERO: el alta con precio 0 la lleva, un precio faltante no, y se quita cuando el precio deja de ser 0', async () => {
    const created = await app.get(AssetsService).create(
      {
        categoryId,
        costCenterId: centerA,
        acquisitionTypeId,
        description: 'Alta sin precio',
        acquisitionDate: '2021-01-01',
      },
      director,
    );
    expect(await flagsOf(created.id)).toContain('PRICE_ZERO');
    const priced = await app.get(AssetsService).create(
      { categoryId, costCenterId: centerA, acquisitionTypeId, description: 'Alta con precio', acquisitionDate: '2021-01-01', acquisitionPrice: 10 },
      director,
    );
    expect(await flagsOf(priced.id)).not.toContain('PRICE_ZERO');
    // Como la importación: un precio que faltaba (PRICE_MISSING) no es un precio cero.
    const missing = await rawAsset(centerB, 0, ['PRICE_MISSING']);
    expect(await flagsOf(missing)).toEqual(['PRICE_MISSING']);

    const zero = await rawAsset(centerB, 0, ['BARCODE_TEMP']);
    expect(await flagsOf(zero)).toEqual(['BARCODE_TEMP', 'PRICE_ZERO']);
    await dataSource.query('UPDATE asset SET acquisition_price = 150 WHERE id = $1', [zero]);
    expect(await flagsOf(zero)).toEqual(['BARCODE_TEMP']);
    await dataSource.query('UPDATE asset SET acquisition_price = 0 WHERE id = $1', [zero]);
    expect(await flagsOf(zero)).toEqual(['BARCODE_TEMP', 'PRICE_ZERO']);
    await dataSource.query('UPDATE asset SET acquisition_price = 1 WHERE id IN ($1, $2)', [zero, created.id]);
  });

  it('lista de trabajo con el alcance de lectura; registrar el motivo no toca el precio, se audita y se filtra por clasificados', async () => {
    const a1 = await rawAsset(centerA, 0);
    const a2 = await rawAsset(centerA, 0);
    await rawAsset(centerA, 99);
    const b1 = await rawAsset(centerB, 0);
    const reason = await http().post('/api/v1/assets/price-zero-reasons').set(auth('director')).send({ label: 'Bien recibido en comodato' });
    const reasonId = reason.body.data.id as string;

    const all = await list('director', { costCenterId: centerA });
    expect(all.items.map((row) => row.id).sort()).toEqual([a1, a2].sort());
    expect(all.summary).toEqual({ total: 2, classified: 0, unclassified: 2 });
    // La consulta del centro A solo ve su centro, aunque pida el B.
    expect((await list('viewerA')).items.every((row) => row.costCenter?.id === centerA)).toBe(true);
    expect((await list('viewerA', { costCenterId: centerB })).total).toBe(0);
    expect((await list('director', { costCenterId: centerB })).items.map((row) => row.id)).toContain(b1);

    const put = (who: string, id: string, body: Record<string, unknown>) =>
      http().put(`/api/v1/assets/${id}/price-zero-reason`).set(auth(who)).send(body);
    expect((await put('viewerA', a1, { reasonId })).status).toBe(403);
    const set = await put('director', a1, { reasonId, note: 'Acta de comodato 2019' });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expectConforms('put', '/api/v1/assets/{id}/price-zero-reason', 200, set.body);
    expect(set.body.data).toMatchObject({
      id: a1,
      reason: { id: reasonId, label: 'Bien recibido en comodato' },
      note: 'Acta de comodato 2019',
      classifiedBy: { userId: director.id },
    });
    expect(await scalar<string>(dataSource, 'SELECT acquisition_price::text FROM asset WHERE id = $1', [a1])).toBe('0.00');
    const [audit] = (await dataSource.query(
      `SELECT action, changes FROM audit_log WHERE entity_type = 'ASSET' AND entity_id = $1 ORDER BY performed_at DESC LIMIT 1`,
      [a1],
    )) as Array<{ action: string; changes: Record<string, unknown> }>;
    expect(audit).toEqual({
      action: 'PRICE_ZERO_REASON',
      changes: { reasonId: { from: null, to: reasonId }, noteChanged: true },
    });
    expect(JSON.stringify(audit?.changes)).not.toContain('comodato 2019');

    const classified = await list('director', { costCenterId: centerA, classified: true });
    expect(classified.items.map((row) => row.id)).toEqual([a1]);
    expect(classified.summary).toEqual({ total: 2, classified: 1, unclassified: 1 });
    expect((await list('director', { costCenterId: centerA, classified: false })).items.map((row) => row.id)).toEqual([a2]);
    expect((await list('director', { reasonId })).items.map((row) => row.id)).toEqual([a1]);

    // Precio distinto de cero, motivo inactivo o inexistente, fuera de alcance.
    const priced = await rawAsset(centerA, 10);
    expect((await put('director', priced, { reasonId })).body.error.code).toBe('ASSET_PRICE_NOT_ZERO');
    const inactive = await http().post('/api/v1/assets/price-zero-reasons').set(auth('director')).send({ label: 'Inactivo', isActive: false });
    expect((await put('director', a2, { reasonId: inactive.body.data.id as string })).body.error.code).toBe(
      'ASSET_PRICE_ZERO_REASON_UNAVAILABLE',
    );
    expect((await put('director', randomUUID(), { reasonId })).status).toBe(404);

    // En uso: no se borra.
    const inUse = await http().delete(`/api/v1/assets/price-zero-reasons/${reasonId}`).set(auth('director'));
    expect([inUse.status, inUse.body.error.code]).toEqual([406, 'ASSET_PRICE_ZERO_REASON_IN_USE']);

    // Si el precio deja de ser 0 la marca se quita y el activo sale de la lista (su motivo queda como historia).
    await dataSource.query('UPDATE asset SET acquisition_price = 500 WHERE id = $1', [a1]);
    expect((await list('director', { costCenterId: centerA })).items.map((row) => row.id)).toEqual([a2]);
    expect(await scalar<number>(dataSource, 'SELECT count(*)::int FROM asset_price_zero_classification WHERE asset_id = $1', [a1])).toBe(1);
  });
});
