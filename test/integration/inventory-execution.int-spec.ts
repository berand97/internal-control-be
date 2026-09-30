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
import { AssetsService } from '../../src/modules/assets/services/assets.service.js';
import { TokenService } from '../../src/modules/auth/services/token.service.js';
import { addDays, bogotaDate } from '../../src/modules/inventories/domain/inventory-schedule.js';
import { discardInventoryActRequests, openTestSession, scalar } from './helpers.js';
import { conform, type Schema } from './openapi-conform.js';

interface Who {
  readonly personId: string;
  readonly userId: string;
  readonly token: string;
  readonly actor: AuthenticatedUser;
}

interface Item {
  id: string;
  assetId: string | null;
  result: string;
  expectedCodeTemporary: boolean | null;
  wasLost: boolean;
  findingCategory: string | null;
  suggestedCategory: string | null;
  missingCauseId: string | null;
  missingCauseLabel: string | null;
  missingCauseOther: string | null;
  voided: boolean;
}

/**
 * Ejecución de la toma física contra PostgreSQL real y por HTTP: quién puede operarla (responsable o
 * inventory:create:global, nunca el auditado), la foto de start(), el cierre con umbral y NOT_VERIFIED, causas de
 * faltante, categorías de hallazgo, correcciones con historial y la conciliación. Las respuestas se comparan con el
 * OpenAPI publicado.
 */
describe('Ejecución de tomas físicas: alcance, foto, cierre, causas, categorías y correcciones (PostgreSQL real)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let openapi: OpenAPIObject;
  let director: Who;
  let approver: Who;
  let responsible: Who;
  let outsiderExecutor: Who;
  let outsiderHead: Who;
  let base: { categoryId: string; acquisitionTypeId: string; roomA: string; roomB: string; otherCenter: string };
  const today = bogotaDate(new Date());

  const http = () => request(app.getHttpServer());
  const as = (who: Who) => ({ Authorization: `Bearer ${who.token}` });

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

  const person = async (first: string, role: string | null, scopeCenter: string | null = null): Promise<Who> => {
    const tag = randomUUID().slice(0, 8);
    const personId = await scalar<string>(
      dataSource,
      `INSERT INTO person (first_name, last_name, email) VALUES ($1, 'Ejecución', $2) RETURNING id`,
      [first, `${first.toLowerCase()}.${tag}@unac.edu.co`],
    );
    const userId = await scalar<string>(
      dataSource,
      `INSERT INTO app_user (person_id, username, password_hash, status) VALUES ($1, $2, 'x', 'ACTIVE') RETURNING id`,
      [personId, `ejec.${tag}`],
    );
    if (role) {
      await dataSource.query(
        `INSERT INTO user_role (user_id, role_id, scope_type, scope_id)
         SELECT $1, id, $3, $4 FROM role WHERE code = $2`,
        [userId, role, scopeCenter ? 'COST_CENTER' : 'GLOBAL', scopeCenter],
      );
    }
    const sessionId = await openTestSession(dataSource, userId);
    const actor: AuthenticatedUser = {
      id: userId,
      personId,
      username: `ejec.${tag}`,
      roles: role ? [role] : [],
      scopes: [],
      mustChangePassword: false,
    };
    const token = app.get(TokenService).signAccessToken({ ...actor, sessionId });
    return { personId, userId, token, actor };
  };

  const center = (label: string) =>
    scalar<string>(dataSource, `INSERT INTO cost_center (external_code, name) VALUES ($1, $2) RETURNING id`, [
      `IT-E${randomUUID().slice(0, 6)}`,
      label,
    ]);

  const head = (personId: string, costCenterId: string) =>
    dataSource.query(
      `INSERT INTO cost_center_head (person_id, cost_center_id, valid_from, reason)
       VALUES ($1, $2, NOW() - interval '1 day', 'Prueba de ejecución')`,
      [personId, costCenterId],
    );

  const newAsset = async (costCenterId: string, extra: { responsibleId?: string } = {}) => {
    const asset = await app.get(AssetsService).create(
      {
        categoryId: base.categoryId,
        costCenterId,
        acquisitionTypeId: base.acquisitionTypeId,
        description: `Ejecución ${randomUUID().slice(0, 6)}`,
        acquisitionDate: '2021-01-01',
        locationId: base.roomA,
        ...extra,
      },
      director.actor,
    );
    return asset.id;
  };

  const schedule = async (costCenterId: string, responsibleUserId: string, offset = 0) => {
    const response = await http()
      .post('/api/v1/inventories')
      .set(as(director))
      .send({
        name: 'Toma de ejecución',
        scope: 'COST_CENTER',
        scopeId: costCenterId,
        plannedStartDate: addDays(today, offset),
        plannedEndDate: addDays(today, offset + 2),
        responsibleUserId,
        reminderOffsetsDays: [],
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body.data.id as string;
  };

  const post = (who: Who, path: string, body: Record<string, unknown> = {}) =>
    http().post(`/api/v1/inventories${path}`).set(as(who)).send(body);

  const errorCode = (response: { body: { error?: { code?: string } } }) => response.body.error?.code;

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
    const campus = await scalar<string>(dataSource, `INSERT INTO campus (code, name) VALUES ('IT-EC', 'Sede ejecución') RETURNING id`);
    const building = await scalar<string>(
      dataSource,
      `INSERT INTO building (campus_id, code, name) VALUES ($1, 'IT-EB', 'Bloque ejecución') RETURNING id`,
      [campus],
    );
    const room = (code: string) =>
      scalar<string>(
        dataSource,
        `INSERT INTO location (building_id, code, name, location_type) VALUES ($1, $2, $2, 'OFFICE') RETURNING id`,
        [building, code],
      );
    const otherCenter = await center('Centro ajeno');
    base = {
      categoryId: await scalar<string>(
        dataSource,
        `INSERT INTO asset_category (code, name, requires_photo) VALUES ('IT_EXEC', 'Categoría ejecución', FALSE) RETURNING id`,
      ),
      acquisitionTypeId: await scalar<string>(dataSource, `SELECT id FROM acquisition_type WHERE code = 'PURCHASE'`),
      roomA: await room('IT-E101'),
      roomB: await room('IT-E102'),
      otherCenter,
    };
    director = await person('Directora', 'INTERNAL_CONTROL_DIRECTOR');
    approver = await person('Aprobador', 'INTERNAL_CONTROL_DIRECTOR');
    responsible = await person('Responsable', 'DEPARTMENT_HEAD', otherCenter);
    outsiderExecutor = await person('Custodio', 'DEPARTMENT_HEAD', otherCenter);
    outsiderHead = await person('Jefe', 'DEPARTMENT_HEAD', otherCenter);
  });

  afterAll(async () => {
    await discardInventoryActRequests(dataSource);
    // Los avisos de tomas no quedan en la cola compartida: otro archivo despacha el outbox por orden de llegada.
    await dataSource.query(`DELETE FROM mail_outbox WHERE entity_type = 'INVENTORY' AND delivery_status = 'PENDING_SEND'`);
    await app.close();
  });

  it('solo el responsable o quien programa tomas la opera; el jefe del centro nunca, aunque tenga el permiso', async () => {
    const centerId = await center('Alcance');
    await newAsset(centerId);
    const headDirector = await person('JefaDirectora', 'INTERNAL_CONTROL_DIRECTOR');
    await head(headDirector.personId, centerId);
    const inventoryId = await schedule(centerId, responsible.userId);

    const byExecutor = await post(outsiderExecutor, `/${inventoryId}/start`);
    expect(byExecutor.status).toBe(403);
    expect(errorCode(byExecutor)).toBe('INVENTORY_ACTOR_NOT_ALLOWED');
    const byHead = await post(outsiderHead, `/${inventoryId}/start`);
    expect(byHead.status).toBe(403);
    expect(errorCode(byHead)).toBe('INVENTORY_ACTOR_NOT_ALLOWED');
    const byAuditedHead = await post(headDirector, `/${inventoryId}/start`);
    expect(byAuditedHead.status).toBe(403);
    expect(errorCode(byAuditedHead)).toBe('INVENTORY_CONFLICT_OF_INTEREST');
    expect(byAuditedHead.body.error.details).toEqual([{ field: 'reason', message: 'COST_CENTER_HEAD' }]);
    expect(await scalar<string>(dataSource, 'SELECT status FROM physical_inventory WHERE id = $1', [inventoryId])).toBe(
      'PLANNED',
    );

    const started = await post(responsible, `/${inventoryId}/start`);
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expectConforms('post', '/api/v1/inventories/{id}/start', 200, started.body);

    const [item] = started.body.data.items as Item[];
    const verifyByOutsider = await post(outsiderExecutor, `/${inventoryId}/verify-asset`, {
      assetId: item?.assetId,
      condition: 'GOOD',
    });
    expect(errorCode(verifyByOutsider)).toBe('INVENTORY_ACTOR_NOT_ALLOWED');
    const closeByAuditedHead = await post(headDirector, `/${inventoryId}/close`, { allowUnverified: true });
    expect(closeByAuditedHead.status).toBe(403);
    expect(errorCode(closeByAuditedHead)).toBe('INVENTORY_CONFLICT_OF_INTEREST');

    // Leer el detalle (trae activos) exige alcance sobre el centro de la toma: un ejecutor de otro centro recibe 404
    // aunque tenga inventory:read:global; quien tiene asset:read:global sí lo lee. La lista no trae activos.
    const hidden = await http().get(`/api/v1/inventories/${inventoryId}`).set(as(outsiderExecutor));
    expect([hidden.status, errorCode(hidden)]).toEqual([404, 'RESOURCE_NOT_FOUND']);
    const read = await http().get(`/api/v1/inventories/${inventoryId}`).set(as(director));
    expect(read.status).toBe(200);
    expectConforms('get', '/api/v1/inventories/{id}', 200, read.body);
    const list = await http().get('/api/v1/inventories').set(as(outsiderHead));
    expect(list.status).toBe(200);
    expectConforms('get', '/api/v1/inventories', 200, list.body);
  });

  it('el custodio de un activo del alcance no ejecuta la toma aunque sea su responsable; quien programa sí', async () => {
    const centerId = await center('Custodia');
    const custodianResponsible = await person('CustodioResponsable', 'DEPARTMENT_HEAD', base.otherCenter);
    await newAsset(centerId, { responsibleId: custodianResponsible.personId });
    const inventoryId = await schedule(centerId, custodianResponsible.userId);

    const denied = await post(custodianResponsible, `/${inventoryId}/start`);
    expect(denied.status).toBe(403);
    expect(errorCode(denied)).toBe('INVENTORY_CONFLICT_OF_INTEREST');
    expect(denied.body.error.details).toEqual([{ field: 'reason', message: 'ASSET_CUSTODIAN' }]);

    const started = await post(director, `/${inventoryId}/start`);
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(started.body.data.status).toBe('IN_PROGRESS');
  });

  it('start congela la foto del centro: sin dados de baja, marca TEMP, fecha de Bogotá y bloqueo de dos EN CURSO', async () => {
    const centerId = await center('Foto');
    const normal = await newAsset(centerId);
    const temporary = await newAsset(centerId);
    const writtenOff = await newAsset(centerId);
    const elsewhere = await newAsset(base.otherCenter);
    await dataSource.query(`UPDATE asset SET data_quality_flags = '{BARCODE_TEMP}' WHERE id = $1`, [temporary]);
    await dataSource.query(
      `UPDATE asset SET operational_status = 'WRITTEN_OFF', written_off_at = CURRENT_DATE WHERE id = $1`,
      [writtenOff],
    );
    const first = await schedule(centerId, responsible.userId);
    const second = await schedule(centerId, responsible.userId, 10);

    const started = await post(responsible, `/${first}/start`);
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const data = started.body.data as { actualStartDate: string; items: Item[]; progress: { expected: number; temporaryCode: number } };
    expect(data.actualStartDate).toBe(today);
    const byAsset = new Map(data.items.map((item) => [item.assetId, item]));
    expect([...byAsset.keys()].sort()).toEqual([normal, temporary].sort());
    expect(byAsset.has(writtenOff)).toBe(false);
    expect(byAsset.has(elsewhere)).toBe(false);
    expect(byAsset.get(temporary)?.expectedCodeTemporary).toBe(true);
    expect(byAsset.get(normal)?.expectedCodeTemporary).toBe(false);
    expect(data.progress).toMatchObject({ expected: 2, temporaryCode: 1 });
    expect(
      await scalar<number>(
        dataSource,
        `SELECT count(*)::int FROM physical_inventory_item WHERE inventory_id = $1 AND verification_result = 'PENDING'`,
        [first],
      ),
    ).toBe(2);

    const overlap = await post(responsible, `/${second}/start`);
    expect(overlap.status).toBe(406);
    expect(errorCode(overlap)).toBe('INVENTORY_SCOPE_OVERLAP');
    expect(await scalar<string>(dataSource, 'SELECT status FROM physical_inventory WHERE id = $1', [second])).toBe('PLANNED');
  });

  it('close: más del 5 % pendiente exige allowUnverified y el permiso de programar; los pendientes quedan NOT_VERIFIED y la conciliación no los toca', async () => {
    const centerId = await center('Umbral');
    const verified = await newAsset(centerId);
    const pendingA = await newAsset(centerId);
    const pendingB = await newAsset(centerId);
    const inventoryId = await schedule(centerId, responsible.userId);
    expect((await post(responsible, `/${inventoryId}/start`)).status).toBe(200);
    expect((await post(responsible, `/${inventoryId}/verify-asset`, { assetId: verified, condition: 'NEW' })).status).toBe(200);

    const refused = await post(responsible, `/${inventoryId}/close`);
    expect(refused.status).toBe(406);
    expect(errorCode(refused)).toBe('INVENTORY_UNVERIFIED_EXCEEDS');
    const unauthorized = await post(responsible, `/${inventoryId}/close`, { allowUnverified: true });
    expect(unauthorized.status).toBe(403);
    expect(errorCode(unauthorized)).toBe('INSUFFICIENT_PERMISSIONS');

    const closed = await post(director, `/${inventoryId}/close`, { allowUnverified: true });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expectConforms('post', '/api/v1/inventories/{id}/close', 200, closed.body);
    expect(closed.body.data).toMatchObject({
      status: 'CLOSED',
      actualEndDate: today,
      closedBy: director.userId,
      closedByName: 'Directora Ejecución',
      cancelledByName: null,
      reconcileRequestedByName: null,
    });
    expect(closed.body.data.progress).toMatchObject({ expected: 3, verified: 1, pending: 0, notVerified: 2, notFound: 0 });
    const results = (await dataSource.query(
      `SELECT asset_id, verification_result FROM physical_inventory_item WHERE inventory_id = $1`,
      [inventoryId],
    )) as Array<{ asset_id: string; verification_result: string }>;
    expect(Object.fromEntries(results.map((row) => [row.asset_id, row.verification_result]))).toEqual({
      [verified]: 'FOUND',
      [pendingA]: 'NOT_VERIFIED',
      [pendingB]: 'NOT_VERIFIED',
    });
    const frozen = await scalar<{ notVerified: number; notVerifiedItems: unknown[] }>(
      dataSource,
      'SELECT discrepancy_report FROM physical_inventory WHERE id = $1',
      [inventoryId],
    );
    expect(frozen.notVerified).toBe(2);
    expect(frozen.notVerifiedItems).toHaveLength(2);
    const report = await http().get(`/api/v1/inventories/${inventoryId}/report`).set(as(director));
    expectConforms('get', '/api/v1/inventories/{id}/report', 200, report.body);
    expect(report.body.data.notVerified).toBe(2);

    expect((await post(responsible, `/${inventoryId}/reconcile`)).status).toBe(200);
    const approved = await post(approver, `/${inventoryId}/reconcile/approve`);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(
      await scalar<number>(
        dataSource,
        `SELECT count(*)::int FROM asset WHERE id = ANY($1) AND operational_status = 'LOST'`,
        [[pendingA, pendingB]],
      ),
    ).toBe(0);
  });

  it('dentro del umbral cierra el responsable sin autorización adicional', async () => {
    const centerId = await center('Dentro del umbral');
    const assets = await Promise.all(Array.from({ length: 21 }, () => newAsset(centerId)));
    const inventoryId = await schedule(centerId, responsible.userId);
    expect((await post(responsible, `/${inventoryId}/start`)).status).toBe(200);
    for (const assetId of assets.slice(0, 20)) {
      expect((await post(responsible, `/${inventoryId}/verify-asset`, { assetId, condition: 'NEW' })).status).toBe(200);
    }
    // 1 de 21 = 4,76 %: no supera el 5 %.
    const closed = await post(responsible, `/${inventoryId}/close`);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.data.progress).toMatchObject({ expected: 21, verified: 20, notVerified: 1 });
  });

  it('flujo completo: verificar, faltantes con causa y con "Otra", sobrantes, categoría, corrección, anulación, cierre y conciliación', async () => {
    const centerId = await center('Flujo');
    const found = await newAsset(centerId);
    const misplaced = await newAsset(centerId);
    const missingOther = await newAsset(centerId);
    const missingCataloged = await newAsset(centerId);
    const lostOutside = await newAsset(base.otherCenter);
    const writtenOffOutside = await newAsset(base.otherCenter);
    const surplusOutside = await newAsset(base.otherCenter);
    await dataSource.query(`UPDATE asset SET operational_status = 'LOST' WHERE id = $1`, [lostOutside]);
    await dataSource.query(
      `UPDATE asset SET operational_status = 'WRITTEN_OFF', written_off_at = CURRENT_DATE WHERE id = $1`,
      [writtenOffOutside],
    );
    const inventoryId = await schedule(centerId, responsible.userId);
    expect((await post(responsible, `/${inventoryId}/start`)).status).toBe(200);

    const verifiedFound = await post(responsible, `/${inventoryId}/verify-asset`, { assetId: found, condition: 'GOOD' });
    expect(verifiedFound.status).toBe(200);
    expectConforms('post', '/api/v1/inventories/{id}/verify-asset', 200, verifiedFound.body);
    expect(verifiedFound.body.data).toMatchObject({ result: 'FOUND', suggestedCategory: 'AU', findingCategory: null });
    const verifiedMisplaced = await post(responsible, `/${inventoryId}/verify-asset`, {
      assetId: misplaced,
      condition: 'OBSOLETE',
      locationId: base.roomB,
    });
    expect(verifiedMisplaced.body.data).toMatchObject({ result: 'MISPLACED', suggestedCategory: 'AOD' });

    // Faltante: exactamente una causa.
    const noCause = await post(responsible, `/${inventoryId}/report-not-found`, { assetId: missingOther });
    expect(noCause.status).toBe(400);
    expect(errorCode(noCause)).toBe('INVENTORY_MISSING_CAUSE_REQUIRED');
    const cause = await http()
      .post('/api/v1/inventories/catalogs/missing-causes')
      .set(as(director))
      .send({ label: 'Hurto con denuncia', sortOrder: 1 });
    expect(cause.status, JSON.stringify(cause.body)).toBe(201);
    expectConforms('post', '/api/v1/inventories/catalogs/missing-causes', 201, cause.body);
    const causeId = cause.body.data.id as string;
    const both = await post(responsible, `/${inventoryId}/report-not-found`, {
      assetId: missingOther,
      causeId,
      otherCause: 'Se lo llevó el contratista',
    });
    expect(errorCode(both)).toBe('INVENTORY_MISSING_CAUSE_REQUIRED');
    const byOther = await post(responsible, `/${inventoryId}/report-not-found`, {
      assetId: missingOther,
      otherCause: '  Se lo llevó el contratista  ',
    });
    expect(byOther.status, JSON.stringify(byOther.body)).toBe(200);
    expectConforms('post', '/api/v1/inventories/{id}/report-not-found', 200, byOther.body);
    expect(byOther.body.data).toMatchObject({
      result: 'MISSING',
      missingCauseId: null,
      missingCauseOther: 'Se lo llevó el contratista',
      suggestedCategory: 'ANE',
    });
    const byCatalog = await post(responsible, `/${inventoryId}/report-not-found`, { assetId: missingCataloged, causeId });
    expect(byCatalog.body.data).toMatchObject({
      result: 'MISSING',
      missingCauseId: causeId,
      missingCauseLabel: 'Hurto con denuncia',
      missingCauseOther: null,
    });
    await expect(
      dataSource.query(
        `UPDATE physical_inventory_item SET missing_cause_id = NULL WHERE inventory_id = $1 AND asset_id = $2`,
        [inventoryId, missingCataloged],
      ),
    ).rejects.toThrow(/chk_inv_item_missing_cause/);

    const usage = await http().get('/api/v1/inventories/catalogs/missing-causes/other-usage').set(as(outsiderExecutor));
    expect(usage.status).toBe(200);
    expectConforms('get', '/api/v1/inventories/catalogs/missing-causes/other-usage', 200, usage.body);
    expect(usage.body.data.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: 'Se lo llevó el contratista', count: 1, inventories: 1 })]),
    );

    // Sobrantes.
    const writtenOff = await post(responsible, `/${inventoryId}/report-unexpected`, { assetId: writtenOffOutside });
    expect(writtenOff.status).toBe(406);
    expect(errorCode(writtenOff)).toBe('INVENTORY_ASSET_WRITTEN_OFF');
    const lost = await post(responsible, `/${inventoryId}/report-unexpected`, { assetId: lostOutside, condition: 'POOR' });
    expect(lost.status).toBe(200);
    expectConforms('post', '/api/v1/inventories/{id}/report-unexpected', 200, lost.body);
    expect(lost.body.data).toMatchObject({ result: 'SURPLUS', wasLost: true, suggestedCategory: 'AOD' });
    const surplus = await post(responsible, `/${inventoryId}/report-unexpected`, { assetId: surplusOutside });
    expect(surplus.body.data).toMatchObject({ result: 'SURPLUS', wasLost: false });
    const mistaken = await post(responsible, `/${inventoryId}/report-unexpected`, { notes: 'Silla sin placa' });
    const mistakenId = mistaken.body.data.id as string;

    // Categoría: la fija el auditor; ANI no se puede asignar.
    const foundItemId = verifiedFound.body.data.id as string;
    const setCategory = await http()
      .put(`/api/v1/inventories/${inventoryId}/items/${foundItemId}/finding-category`)
      .set(as(responsible))
      .send({ code: 'au' });
    expect(setCategory.status, JSON.stringify(setCategory.body)).toBe(200);
    expectConforms('put', '/api/v1/inventories/{id}/items/{itemId}/finding-category', 200, setCategory.body);
    expect(setCategory.body.data.findingCategory).toBe('AU');
    const ani = await http()
      .put(`/api/v1/inventories/${inventoryId}/items/${foundItemId}/finding-category`)
      .set(as(responsible))
      .send({ code: 'ANI' });
    expect(ani.status).toBe(406);
    expect(errorCode(ani)).toBe('INVENTORY_CATALOG_ENTRY_UNAVAILABLE');
    const setByOutsider = await http()
      .put(`/api/v1/inventories/${inventoryId}/items/${foundItemId}/finding-category`)
      .set(as(outsiderExecutor))
      .send({ code: 'AU' });
    expect(errorCode(setByOutsider)).toBe('INVENTORY_ACTOR_NOT_ALLOWED');

    // Corrección con evidencia: el faltante del catálogo apareció.
    const cataloguedItemId = byCatalog.body.data.id as string;
    const missingReason = await post(responsible, `/${inventoryId}/items/${cataloguedItemId}/correct`, { result: 'FOUND' });
    expect(missingReason.status).toBe(400);
    const corrected = await post(responsible, `/${inventoryId}/items/${cataloguedItemId}/correct`, {
      result: 'FOUND',
      actualCondition: 'FAIR',
      reason: 'Estaba en la bodega del piso',
    });
    expect(corrected.status, JSON.stringify(corrected.body)).toBe(200);
    expectConforms('post', '/api/v1/inventories/{id}/items/{itemId}/correct', 200, corrected.body);
    expect(corrected.body.data.item).toMatchObject({
      result: 'FOUND',
      missingCauseId: null,
      missingCauseOther: null,
      suggestedCategory: 'AU',
    });
    expect(corrected.body.data.correction).toMatchObject({
      kind: 'CORRECT',
      reason: 'Estaba en la bodega del piso',
      correctedBy: responsible.userId,
      correctedByName: 'Responsable Ejecución',
      before: { result: 'MISSING', missingCauseId: causeId },
      after: { result: 'FOUND', actualCondition: 'FAIR', missingCauseId: null },
    });
    const noChange = await post(responsible, `/${inventoryId}/items/${cataloguedItemId}/correct`, {
      result: 'FOUND',
      actualCondition: 'FAIR',
      reason: 'Otra vez lo mismo',
    });
    expect(noChange.status).toBe(400);
    const misplacedWithoutLocation = await post(responsible, `/${inventoryId}/items/${cataloguedItemId}/correct`, {
      result: 'MISPLACED',
      actualCondition: 'FAIR',
      reason: 'Estaba en otra oficina',
    });
    expect(misplacedWithoutLocation.status).toBe(400);
    const surplusCorrection = await post(responsible, `/${inventoryId}/items/${mistakenId}/correct`, {
      result: 'FOUND',
      actualCondition: 'GOOD',
      reason: 'No aplica a sobrantes',
    });
    expect(errorCode(surplusCorrection)).toBe('INVALID_STATE');
    const history = await http()
      .get(`/api/v1/inventories/${inventoryId}/items/${cataloguedItemId}/corrections`)
      .set(as(director));
    expectConforms('get', '/api/v1/inventories/{id}/items/{itemId}/corrections', 200, history.body);
    expect(history.body.data).toHaveLength(1);
    expect(history.body.data[0]).toMatchObject({ correctedBy: responsible.userId, correctedByName: 'Responsable Ejecución' });

    // Anular el sobrante registrado por error.
    const voided = await post(responsible, `/${inventoryId}/items/${mistakenId}/void`, { reason: 'Registrado dos veces' });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expectConforms('post', '/api/v1/inventories/{id}/items/{itemId}/void', 200, voided.body);
    expect(voided.body.data.item).toMatchObject({
      voided: true,
      suggestedCategory: null,
      verifiedByName: 'Responsable Ejecución',
      resolvedByName: null,
    });
    expect(voided.body.data.correction).toMatchObject({ kind: 'VOID', before: { voided: false }, after: { voided: true } });
    expect((await post(responsible, `/${inventoryId}/items/${mistakenId}/void`, { reason: 'Otra vez' })).status).toBe(406);

    // Catálogo: lo usado no se borra, se desactiva.
    const deleteUsed = await http().delete(`/api/v1/inventories/catalogs/missing-causes/${causeId}`).set(as(director));
    // La corrección quitó la causa del ítem, pero el historial la cita: sigue en uso.
    expect(deleteUsed.status).toBe(406);
    expect(errorCode(deleteUsed)).toBe('INVENTORY_CATALOG_ENTRY_IN_USE');
    const deleteCategory = await http().delete('/api/v1/inventories/catalogs/finding-categories/AU').set(as(director));
    expect(deleteCategory.status).toBe(406);
    expect(errorCode(deleteCategory)).toBe('INVENTORY_CATALOG_ENTRY_IN_USE');

    const progress = await http().get(`/api/v1/inventories/${inventoryId}/progress`).set(as(responsible));
    expectConforms('get', '/api/v1/inventories/{id}/progress', 200, progress.body);
    expect(progress.body.data).toMatchObject({
      expected: 4,
      pending: 0,
      verified: 3,
      notFound: 1,
      misplaced: 1,
      unexpected: 2,
      voidedUnexpected: 1,
    });

    const closed = await post(responsible, `/${inventoryId}/close`);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const report = closed.body.data.report as { notFoundItems: Item[]; unexpectedItems: Item[] };
    expect(report.notFoundItems.map((item) => item.assetId)).toEqual([missingOther]);
    expect(report.unexpectedItems.map((item) => item.assetId).sort()).toEqual([lostOutside, surplusOutside].sort());
    expect(await post(responsible, `/${inventoryId}/items/${foundItemId}/correct`, { result: 'PENDING', reason: 'Tarde' }).then((r) => r.status)).toBe(406);

    expect((await post(responsible, `/${inventoryId}/reconcile`)).status).toBe(200);
    const approved = await post(approver, `/${inventoryId}/reconcile/approve`);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const state = (await dataSource.query(
      `SELECT id, operational_status, physical_condition, current_location_id FROM asset WHERE id = ANY($1)`,
      [[found, misplaced, missingOther, missingCataloged, lostOutside]],
    )) as Array<{ id: string; operational_status: string; physical_condition: string; current_location_id: string }>;
    const byId = new Map(state.map((row) => [row.id, row]));
    expect(byId.get(misplaced)).toMatchObject({ current_location_id: base.roomB, physical_condition: 'OBSOLETE' });
    expect(byId.get(found)).toMatchObject({ physical_condition: 'GOOD', operational_status: 'IN_USE' });
    expect(byId.get(missingCataloged)).toMatchObject({ physical_condition: 'FAIR', operational_status: 'IN_USE' });
    expect(byId.get(missingOther)?.operational_status).toBe('LOST');
    // El sobrante de un activo LOST no lo recupera la conciliación.
    expect(byId.get(lostOutside)?.operational_status).toBe('LOST');

    const audit = (await dataSource.query(
      `SELECT action, changes::text AS changes FROM audit_log WHERE entity_type = 'INVENTORY' AND entity_id = $1`,
      [inventoryId],
    )) as Array<{ action: string; changes: string }>;
    expect(audit.map((row) => row.action)).toEqual(
      expect.arrayContaining(['INV_STARTED', 'INV_FINDING_SET', 'INV_ITEM_CORRECTED', 'INV_ITEM_VOIDED', 'INV_CLOSED']),
    );
    for (const row of audit) {
      expect(row.changes).not.toContain('bodega');
      expect(row.changes).not.toContain('contratista');
      expect(row.changes).not.toContain('Registrado dos veces');
    }
  });

  it('catálogos: leer con inventory:read, administrar solo con inventory_catalog:manage; tres categorías, sin ANI ni marca de pendiente', async () => {
    const list = await http().get('/api/v1/inventories/catalogs/finding-categories').set(as(outsiderExecutor));
    expect(list.status).toBe(200);
    expectConforms('get', '/api/v1/inventories/catalogs/finding-categories', 200, list.body);
    const rows = list.body.data as Array<{ code: string; label: string; isActive: boolean } & Record<string, unknown>>;
    const byCode = new Map(rows.map((row) => [row.code, row]));
    expect(byCode.has('ANI')).toBe(false);
    expect(rows.some((row) => 'pendingDefinition' in row)).toBe(false);
    expect(['AU', 'ANE', 'AOD'].map((code) => [code, byCode.get(code)?.label, byCode.get(code)?.isActive])).toEqual([
      ['AU', 'Activos en uso', true],
      ['ANE', 'Activos no encontrados', true],
      ['AOD', 'Activos obsoletos dañados', true],
    ]);
    expect(byCode.get('AOD')).toMatchObject({ suggestConditions: ['OBSOLETE', 'POOR'] });

    const denied = await http()
      .post('/api/v1/inventories/catalogs/finding-categories')
      .set(as(outsiderExecutor))
      .send({ code: 'XX', label: 'No permitida' });
    expect(denied.status).toBe(403);

    const created = await http()
      .post('/api/v1/inventories/catalogs/finding-categories')
      .set(as(director))
      .send({ code: 'itx', label: 'Prueba', suggestConditions: ['FAIR'], sortOrder: 99 });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expectConforms('post', '/api/v1/inventories/catalogs/finding-categories', 201, created.body);
    expect(created.body.data).toMatchObject({ code: 'ITX', inUse: false, isActive: true });
    const duplicated = await http()
      .post('/api/v1/inventories/catalogs/finding-categories')
      .set(as(director))
      .send({ code: 'ITX', label: 'Otra' });
    expect(errorCode(duplicated)).toBe('INVENTORY_CATALOG_ENTRY_EXISTS');
    const patched = await http()
      .patch('/api/v1/inventories/catalogs/finding-categories/ITX')
      .set(as(director))
      .send({ isActive: false, description: 'Solo pruebas' });
    expect(patched.status).toBe(200);
    expectConforms('patch', '/api/v1/inventories/catalogs/finding-categories/{code}', 200, patched.body);
    expect(patched.body.data).toMatchObject({ isActive: false, description: 'Solo pruebas' });
    const removed = await http().delete('/api/v1/inventories/catalogs/finding-categories/ITX').set(as(director));
    expect(removed.status).toBe(200);
    expectConforms('delete', '/api/v1/inventories/catalogs/finding-categories/{code}', 200, removed.body);

    const causes = await http().get('/api/v1/inventories/catalogs/missing-causes').set(as(outsiderHead));
    expect(causes.status).toBe(200);
    expectConforms('get', '/api/v1/inventories/catalogs/missing-causes', 200, causes.body);
    const repeated = await http()
      .post('/api/v1/inventories/catalogs/missing-causes')
      .set(as(director))
      .send({ label: 'HURTO con denuncia' });
    expect(errorCode(repeated)).toBe('INVENTORY_CATALOG_ENTRY_EXISTS');

    // 1767225895000: SUPER_ADMIN no tiene permisos operativos; solo el director administra los catálogos.
    expect(
      await dataSource.query(
        `SELECT r.code FROM role_permission rp JOIN role r ON r.id = rp.role_id JOIN permission p ON p.id = rp.permission_id
         WHERE p.code = 'inventory_catalog:manage:global' ORDER BY r.code`,
      ),
    ).toEqual([{ code: 'INTERNAL_CONTROL_DIRECTOR' }]);
  });
});
