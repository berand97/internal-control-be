import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { createAppValidationPipe } from '../../src/common/pipes/app-validation.pipe.js';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';
import { TokenService } from '../../src/modules/auth/services/token.service.js';
import { createActor, openTestSession, scalar } from './helpers.js';
import { conform, type Schema } from './openapi-conform.js';

/**
 * Edición del activo sin campos descartados en silencio: el precio de compra se corrige con motivo (bitácora con el
 * valor anterior y el nuevo, movimiento CORRECTION en el historial, marca PRICE_ZERO por el trigger, clasificación de
 * precio cero conservada como histórico), el documento de adquisición y la foto se guardan, y tipo y fecha de
 * adquisición se rechazan si cambian. El detalle trae el motivo de precio cero. PostgreSQL real y HTTP, contra el
 * OpenAPI publicado.
 */
describe('Edición del activo: corrección del precio de compra y campos que antes se ignoraban (PostgreSQL real)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let openapi: OpenAPIObject;
  let director: AuthenticatedUser;
  let centerA: string;
  let categoryId: string;
  let acquisitionTypeId: string;
  const tokens: Record<string, string> = {};
  const reasonIds: string[] = [];

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

  const rawAsset = async (price: number, flags: string[] = []) =>
    scalar<string>(
      dataSource,
      `INSERT INTO asset (internal_code, description, category_id, acquisition_type_id, acquisition_date, acquisition_price,
         current_cost_center_id, created_by, data_quality_flags)
       VALUES ($1, 'Activo a corregir', $2, $3, '2020-01-01', $4, $5, $6, $7) RETURNING id`,
      [`PC-${randomUUID().slice(0, 8)}`, categoryId, acquisitionTypeId, price, centerA, director.id, flags],
    );

  const flagsOf = (id: string) => scalar<string[]>(dataSource, 'SELECT data_quality_flags FROM asset WHERE id = $1', [id]);
  const patch = (id: string, body: Record<string, unknown>, who = 'director') =>
    http().patch(`/api/v1/assets/${id}`).set(auth(who)).send(body);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
    dataSource = app.get(DataSource);
    openapi = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    const tag = randomUUID().slice(0, 6);
    centerA = await scalar<string>(dataSource, `INSERT INTO cost_center (external_code, name) VALUES ($1, 'Centro precio') RETURNING id`, [
      `PC-${tag}`,
    ]);
    categoryId = await scalar<string>(
      dataSource,
      `INSERT INTO asset_category (code, name, requires_photo) VALUES ($1, 'Categoría corrección', FALSE) RETURNING id`,
      [`PC_${tag}`],
    );
    acquisitionTypeId = await scalar<string>(dataSource, `SELECT id FROM acquisition_type WHERE code = 'PURCHASE'`);
    director = await userWith('director', 'INTERNAL_CONTROL_DIRECTOR', 'GLOBAL');
    await userWith('jefe', 'DEPARTMENT_HEAD', 'COST_CENTER', centerA);
  });

  afterAll(async () => {
    // El catálogo de motivos nace vacío (asset-price-zero lo comprueba): no se dejan motivos de este archivo.
    await dataSource.query('DELETE FROM asset_price_zero_classification WHERE reason_id = ANY($1::uuid[])', [reasonIds]);
    await dataSource.query('DELETE FROM asset_price_zero_reason WHERE id = ANY($1::uuid[])', [reasonIds]);
    await app.close();
  });

  it('corrige un precio cero con motivo: bitácora con el valor anterior y el nuevo, CORRECTION en el historial, sin PRICE_ZERO y con el motivo de precio cero como histórico', async () => {
    const id = await rawAsset(0);
    expect(await flagsOf(id)).toContain('PRICE_ZERO');
    const reason = await http().post('/api/v1/assets/price-zero-reasons').set(auth('director')).send({ label: `Donación ${randomUUID().slice(0, 4)}` });
    const reasonId = reason.body.data.id as string;
    reasonIds.push(reasonId);
    await http().put(`/api/v1/assets/${id}/price-zero-reason`).set(auth('director')).send({ reasonId, note: 'Sin factura' }).expect(200);

    // El detalle trae el motivo de precio cero.
    const before = await http().get(`/api/v1/assets/${id}`).set(auth('director')).expect(200);
    expectConforms('get', '/api/v1/assets/{id}', 200, before.body);
    expect(before.body.data.priceZeroReason).toMatchObject({
      id: reasonId,
      name: reason.body.data.label,
      note: 'Sin factura',
      classifiedBy: { userId: director.id },
    });
    expect(typeof before.body.data.priceZeroReason.classifiedAt).toBe('string');

    // Sin motivo no se corrige; solo con asset:update:global.
    const noReason = await patch(id, { acquisitionPrice: 1250000 });
    expect([noReason.status, noReason.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);
    expect(noReason.body.error.details).toEqual([expect.objectContaining({ field: 'priceChangeReason' })]);
    expect((await patch(id, { acquisitionPrice: 1250000, priceChangeReason: 'Factura' }, 'jefe')).status).toBe(403);
    expect(await scalar<string>(dataSource, 'SELECT acquisition_price::text FROM asset WHERE id = $1', [id])).toBe('0.00');

    const fixed = await patch(id, { acquisitionPrice: 1250000, priceChangeReason: 'Precio de la factura FV-2019-0331' });
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
    expectConforms('patch', '/api/v1/assets/{id}', 200, fixed.body);
    expect(fixed.body.data.acquisitionPrice).toBe(1250000);
    expect(fixed.body.data.dataQualityFlags).not.toContain('PRICE_ZERO');
    // La clasificación queda como histórico.
    expect(fixed.body.data.priceZeroReason).toMatchObject({ id: reasonId });

    const [audit] = (await dataSource.query(
      `SELECT changes FROM audit_log WHERE entity_type = 'ASSET' AND entity_id = $1 AND action = 'ASSET_UPDATED'
       ORDER BY performed_at DESC LIMIT 1`,
      [id],
    )) as Array<{ changes: Record<string, unknown> }>;
    expect(audit?.changes['acquisitionPrice']).toEqual({ from: '0.00', to: '1250000.00' });
    expect(JSON.stringify(audit?.changes)).not.toContain('FV-2019-0331');

    const [movement] = (await dataSource.query(
      `SELECT movement_type::text AS type, reason, metadata FROM asset_movement WHERE asset_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [id],
    )) as Array<{ type: string; reason: string; metadata: Record<string, unknown> }>;
    expect(movement).toMatchObject({
      type: 'CORRECTION',
      reason: 'Corrección del precio de compra: Precio de la factura FV-2019-0331',
      metadata: { priceChange: { field: 'acquisitionPrice', from: '0.00', to: '1250000.00' } },
    });
    const timeline = await http().get(`/api/v1/assets/${id}/timeline`).query({ order: 'desc' }).set(auth('director')).expect(200);
    expectConforms('get', '/api/v1/assets/{id}/timeline', 200, timeline.body);
    expect(timeline.body.data.items[0]).toMatchObject({
      kind: 'MOVEMENT',
      type: 'CORRECTION',
      summary: 'Corrección del precio de compra: 0.00 → 1250000.00',
      actor: { userId: director.id },
    });

    // El mismo precio no es una corrección: no pide motivo ni deja movimiento.
    const movements = await scalar<number>(dataSource, 'SELECT count(*)::int FROM asset_movement WHERE asset_id = $1', [id]);
    expect((await patch(id, { acquisitionPrice: 1250000 })).status).toBe(200);
    expect(await scalar<number>(dataSource, 'SELECT count(*)::int FROM asset_movement WHERE asset_id = $1', [id])).toBe(movements);

    // Volver a 0 lo vuelve a marcar (trigger).
    expect((await patch(id, { acquisitionPrice: 0, priceChangeReason: 'Era una donación' })).status).toBe(200);
    expect(await flagsOf(id)).toContain('PRICE_ZERO');
  });

  it('un precio que faltaba en el origen deja de estar marcado PRICE_MISSING al corregirlo', async () => {
    const id = await rawAsset(0, ['PRICE_MISSING']);
    expect(await flagsOf(id)).toEqual(['PRICE_MISSING']);
    expect((await patch(id, { acquisitionPrice: 480000, priceChangeReason: 'Precio del contrato' })).status).toBe(200);
    expect(await flagsOf(id)).toEqual([]);
  });

  it('tipo y fecha de adquisición: iguales se aceptan, distintos 400; el documento de adquisición y la foto se guardan', async () => {
    const id = await rawAsset(100);
    const otherType = await scalar<string>(dataSource, `SELECT id FROM acquisition_type WHERE id <> $1 LIMIT 1`, [acquisitionTypeId]);
    const same = await patch(id, { acquisitionTypeId, acquisitionDate: '2020-01-01', description: 'Mismo tipo y fecha' });
    expect(same.status, JSON.stringify(same.body)).toBe(200);
    const changed = await patch(id, { acquisitionTypeId: otherType, acquisitionDate: '2021-05-05' });
    expect([changed.status, changed.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);
    expect(changed.body.error.details.map((detail: { field: string }) => detail.field)).toEqual(['acquisitionTypeId', 'acquisitionDate']);
    expect(await scalar<string>(dataSource, 'SELECT acquisition_date::text FROM asset WHERE id = $1', [id])).toBe('2020-01-01');

    const saved = await patch(id, { acquisitionDocument: 'FV-2020-0101', photoUrl: 'https://fotos.unac.edu.co/activo-1.jpg' });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.data.acquisitionDocument).toBe('FV-2020-0101');
    const photos = async () =>
      (await dataSource.query('SELECT file_url, is_primary FROM asset_photo WHERE asset_id = $1 ORDER BY uploaded_at', [id])) as Array<{
        file_url: string;
        is_primary: boolean;
      }>;
    expect(await photos()).toEqual([{ file_url: 'https://fotos.unac.edu.co/activo-1.jpg', is_primary: true }]);
    // La misma foto no se duplica; otra pasa a ser la principal y la anterior queda.
    expect((await patch(id, { photoUrl: 'https://fotos.unac.edu.co/activo-1.jpg' })).status).toBe(200);
    expect((await patch(id, { photoUrl: 'https://fotos.unac.edu.co/activo-2.jpg' })).status).toBe(200);
    expect(await photos()).toEqual([
      { file_url: 'https://fotos.unac.edu.co/activo-1.jpg', is_primary: false },
      { file_url: 'https://fotos.unac.edu.co/activo-2.jpg', is_primary: true },
    ]);
  });

  it('un activo sin motivo de precio cero trae priceZeroReason null en el detalle; la lista no lo trae', async () => {
    const id = await rawAsset(0);
    const detail = await http().get(`/api/v1/assets/${id}`).set(auth('director')).expect(200);
    expect(detail.body.data.priceZeroReason).toBeNull();
    const list = await http().get('/api/v1/assets').query({ q: 'Activo a corregir', pageSize: 5 }).set(auth('director')).expect(200);
    for (const item of list.body.data.items as Array<Record<string, unknown>>) {
      expect('priceZeroReason' in item).toBe(false);
    }
  });
});
