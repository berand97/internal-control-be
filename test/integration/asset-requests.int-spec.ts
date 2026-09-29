import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import QRCode from 'qrcode';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { applyTrustProxy } from '../../src/common/http/trust-proxy.js';
import { createAppValidationPipe } from '../../src/common/pipes/app-validation.pipe.js';
import type { AppConfig } from '../../src/config/configuration.js';
import { AssetRequestsService } from '../../src/modules/asset-requests/services/asset-requests.service.js';
import { TokenService } from '../../src/modules/auth/services/token.service.js';
import { PDF_CONVERTER } from '../../src/modules/documents/pdf/pdf-converter.js';
import { DocumentEngineService } from '../../src/modules/documents/services/document-engine.service.js';
import { conform, type Schema } from './openapi-conform.js';
import { createPermissionRole, scalar, useSharedStorage } from './helpers.js';
import { DocxTextPdfConverter } from './pdf-text.js';

const LOAN_FORMAT = 'OCI-01-65';
const TRANSFER_FORMAT = 'OCI-17-89';

interface Actor {
  userId: string;
  personId: string;
  token: string;
}

const bogotaToday = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
const plusDays = (days: number): string => {
  const date = new Date(`${bogotaToday()}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

describe('Solicitud de activos entre centros (HTTP real + PostgreSQL real)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let engine: DocumentEngineService;
  let openapi: OpenAPIObject;
  let director: Actor;
  let auditor: Actor;
  let accountant: Actor;
  let requester: Actor;
  let ownerHead: Actor;
  let bothHead: Actor;
  let outsider: Actor;
  let rubric = '';
  let requesting = '';
  let owner = '';
  let headless = '';
  let categoryId = '';
  let reasonId = '';
  const templateIds: string[] = [];
  const sequencesBefore: Array<{ format_key: string; period: string; current_value: string }> = [];

  const http = () => request(app.getHttpServer());
  const auth = (who: Actor) => ({ Authorization: `Bearer ${who.token}` });

  const actor = async (first: string, roles: ReadonlyArray<string>, heads: ReadonlyArray<string> = []): Promise<Actor> => {
    const tag = randomUUID().slice(0, 8);
    const personId = await scalar<string>(
      dataSource,
      `INSERT INTO person (first_name, last_name, email, document_type, document_number, position_title)
       VALUES ($1, 'Solicitud', $2, 'CC', $3, 'Funcionario de prueba') RETURNING id`,
      [first, `solicitud.${tag}@unac.edu.co`, `8${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 1000)}`],
    );
    const userId = await scalar<string>(
      dataSource,
      `INSERT INTO app_user (person_id, username, password_hash, mfa_enabled, status) VALUES ($1, $2, 'x', TRUE, 'ACTIVE') RETURNING id`,
      [personId, `solicitud.${tag}`],
    );
    for (const role of roles) {
      await dataSource.query(
        `INSERT INTO user_role (user_id, role_id, scope_type, scope_id) SELECT $1, id, 'GLOBAL', NULL FROM role WHERE code = $2`,
        [userId, role],
      );
    }
    for (const center of heads) {
      await dataSource.query(`INSERT INTO cost_center_head (person_id, cost_center_id, reason) VALUES ($1, $2, 'Prueba')`, [personId, center]);
    }
    const sessionId = randomUUID();
    await dataSource.query(
      `INSERT INTO refresh_token_family (id, user_id, current_jti, expires_at, mfa_verified_at) VALUES ($1, $2, $3, NOW() + interval '1 day', NOW())`,
      [sessionId, userId, randomUUID()],
    );
    const token = app.get(TokenService).signAccessToken({
      id: userId,
      personId,
      username: `solicitud.${tag}`,
      roles: [],
      scopes: [],
      mustChangePassword: false,
      sessionId,
    });
    return { userId, personId, token };
  };

  const center = (name: string) =>
    scalar<string>(dataSource, `INSERT INTO cost_center (external_code, name) VALUES ($1, $2) RETURNING id`, [
      `S${randomUUID().slice(0, 7).toUpperCase()}`,
      name,
    ]);

  const asset = (costCenterId: string, status = 'IN_USE') => {
    const tag = randomUUID().slice(0, 8).toUpperCase();
    return scalar<string>(
      dataSource,
      `INSERT INTO asset (internal_code, description, category_id, acquisition_type_id, acquisition_date, acquisition_price,
         serial_number, current_cost_center_id, created_by, physical_condition, operational_status)
       VALUES ($1, $2, $3, (SELECT id FROM acquisition_type WHERE code = 'PURCHASE'), '2023-01-10', 1500000, $4, $5, $6, 'GOOD', $7)
       RETURNING id`,
      [`SOL-${tag}`, `PORTATIL SOLICITUD ${tag}`, categoryId, `SN-${tag}`, costCenterId, director.userId, status],
    );
  };

  const temporary = (overrides: Record<string, unknown> = {}) => ({
    kind: 'TEMPORARY',
    requestingCostCenterId: requesting,
    ownerCostCenterId: owner,
    description: 'Dos portátiles para la inducción',
    note: 'Ojalá los de serie SN-123',
    startDate: bogotaToday(),
    expectedReturnDate: plusDays(10),
    ...overrides,
  });

  const create = (body: Record<string, unknown>, who: Actor = requester) => http().post('/api/v1/asset-requests').set(auth(who)).send(body);
  const detail = async (id: string, who: Actor = requester) => (await http().get(`/api/v1/asset-requests/${id}`).set(auth(who)).expect(200)).body.data;
  const sign = (documentId: string, order: number, who: Actor) =>
    http().post(`/api/v1/documents/${documentId}/signatures/${order}`).set(auth(who)).send({ rubric });
  const notices = (userId: string, id: string) =>
    dataSource.query(`SELECT notification_type AS type FROM notification WHERE recipient_user_id = $1 AND entity_id = $2 ORDER BY created_at`, [
      userId,
      id,
    ]) as Promise<Array<{ type: string }>>;

  const expectConforms = (method: string, route: string, status: number, body: unknown) => {
    const operation = (openapi.paths[route] as Record<string, { responses: Record<string, { content?: Record<string, { schema: Schema }> }> }>)[method];
    const schema = operation?.responses[String(status)]?.content?.['application/json']?.schema;
    expect(schema, `${method.toUpperCase()} ${route} ${status} no declara esquema`).toBeDefined();
    const errors: string[] = [];
    conform(openapi, body, schema ?? {}, `${method.toUpperCase()} ${route}`, errors);
    expect(errors).toEqual([]);
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PDF_CONVERTER)
      .useValue(new DocxTextPdfConverter())
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    applyTrustProxy(app, app.get(ConfigService<AppConfig, true>).getOrThrow('trustProxy', { infer: true }));
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
    for (const job of app.get(SchedulerRegistry).getCronJobs().values()) {
      await job.stop();
    }
    dataSource = app.get(DataSource);
    engine = app.get(DocumentEngineService);
    openapi = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    await useSharedStorage(dataSource);
    sequencesBefore.push(
      ...((await dataSource.query('SELECT format_key, period, current_value FROM document_sequence WHERE format_key = ANY($1)', [
        [LOAN_FORMAT, TRANSFER_FORMAT],
      ])) as typeof sequencesBefore),
    );
    requesting = await center('Talento Humano Solicitudes');
    owner = await center('Sistemas Solicitudes');
    headless = await center('Centro sin jefe Solicitudes');
    categoryId = await scalar<string>(
      dataSource,
      `INSERT INTO asset_category (code, name, requires_photo) VALUES ($1, 'Cómputo de solicitudes', FALSE) RETURNING id`,
      [`SOL_${randomUUID().slice(0, 6).toUpperCase()}`],
    );
    reasonId = await scalar<string>(dataSource, `SELECT id FROM asset_transfer_reason WHERE code = 'REUBICACION'`);
    director = await actor('Directora', ['INTERNAL_CONTROL_DIRECTOR']);
    // Revisa solicitudes y firma por Control Interno por sus permisos, con un rol cualquiera (no por llamarse AUDITOR).
    auditor = await actor('Auditora', ['AUDITOR', await createPermissionRole(dataSource, ['asset_request:review:global', 'act:sign_control:global'], 'IT_REVISORA')]);
    accountant = await actor('Contadora', ['CONTABILIDAD']);
    requester = await actor('Solicitante', ['DEPARTMENT_HEAD'], [requesting]);
    ownerHead = await actor('Dueña', ['DEPARTMENT_HEAD'], [owner]);
    bothHead = await actor('Doble', ['DEPARTMENT_HEAD'], [requesting, owner]);
    outsider = await actor('Ajena', ['DEPARTMENT_HEAD'], [await center('Otro centro Solicitudes')]);
    rubric = `data:image/png;base64,${(await QRCode.toBuffer('rubrica', { width: 120 })).toString('base64')}`;
    for (const [format, file] of [
      [LOAN_FORMAT, 'templates/formats/OCI-01-65-v2.docx'],
      [TRANSFER_FORMAT, 'templates/formats/OCI-17-89-v1.docx'],
    ] as const) {
      const uploaded = await engine.uploadTemplate(
        format,
        { buffer: await readFile(file), originalname: `${format}.docx` },
        { sgcVersion: '9', effectiveDate: bogotaToday() },
        director.userId,
      );
      templateIds.push(uploaded.id ?? '');
    }
  });

  afterAll(async () => {
    const requestIds = ((await dataSource.query('SELECT id, loan_id, transfer_id FROM asset_request')) as Array<{
      id: string;
      loan_id: string | null;
      transfer_id: string | null;
    }>);
    const loanIds = requestIds.map((row) => row.loan_id).filter(Boolean);
    const transferIds = requestIds.map((row) => row.transfer_id).filter(Boolean);
    const docs = ((await dataSource.query(
      `SELECT id FROM document WHERE (entity_type = 'LOAN' AND entity_id = ANY($1::uuid[])) OR (entity_type = 'TRANSFER' AND entity_id = ANY($2::uuid[]))`,
      [loanIds, transferIds],
    )) as Array<{ id: string }>).map((row) => row.id);
    // Los avisos no quedan en la cola: otro archivo despacha el outbox por orden de llegada.
    await dataSource.query(`DELETE FROM mail_outbox WHERE entity_type = 'ASSET_REQUEST'`);
    await dataSource.query(`DELETE FROM notification WHERE entity_type = 'ASSET_REQUEST'`);
    await dataSource.query('DELETE FROM asset_request_event');
    await dataSource.query('DELETE FROM asset_request_item');
    await dataSource.query('UPDATE asset_loan SET asset_request_id = NULL, delivery_document_id = NULL WHERE id = ANY($1::uuid[])', [loanIds]);
    await dataSource.query('UPDATE asset_transfer SET asset_request_id = NULL WHERE id = ANY($1::uuid[])', [transferIds]);
    await dataSource.query('DELETE FROM asset_request');
    await dataSource.query('DELETE FROM asset_transfer_item WHERE transfer_id = ANY($1::uuid[])', [transferIds]);
    await dataSource.query('DELETE FROM asset_transfer WHERE id = ANY($1::uuid[])', [transferIds]);
    await dataSource.query('DELETE FROM signature_envelope_signer WHERE envelope_id IN (SELECT id FROM signature_envelope WHERE document_id = ANY($1))', [docs]);
    await dataSource.query('DELETE FROM document_signature_reassignment WHERE document_id = ANY($1)', [docs]);
    await dataSource.query('DELETE FROM signature_signing_link WHERE document_id = ANY($1)', [docs]);
    await dataSource.query('DELETE FROM signature_envelope WHERE document_id = ANY($1)', [docs]);
    await dataSource.query(
      `DELETE FROM document_request WHERE (payload->>'entityType' = 'LOAN' AND payload->>'entityId' = ANY($1::text[]))
         OR (payload->>'entityType' = 'TRANSFER' AND payload->>'entityId' = ANY($2::text[]))`,
      [loanIds, transferIds],
    );
    await dataSource.query('DELETE FROM document_asset WHERE document_id = ANY($1)', [docs]);
    await dataSource.query('DELETE FROM document WHERE id = ANY($1)', [docs]);
    await dataSource.query('DELETE FROM document_template_version WHERE id = ANY($1::uuid[])', [templateIds.filter(Boolean)]);
    await dataSource.query('DELETE FROM document_sequence WHERE format_key = ANY($1)', [[LOAN_FORMAT, TRANSFER_FORMAT]]);
    for (const sequence of sequencesBefore) {
      await dataSource.query('INSERT INTO document_sequence (format_key, period, current_value) VALUES ($1, $2, $3)', [
        sequence.format_key,
        sequence.period,
        sequence.current_value,
      ]);
    }
    await dataSource.query(
      `UPDATE user_role SET revoked_at = NOW() WHERE revoked_at IS NULL AND user_id = ANY($1)`,
      [[director, auditor, accountant, requester, ownerHead, bothHead, outsider].map((who) => who.userId)],
    );
    await app.close();
  });

  it('centros para solicitar: un jefe sin cost_center:read:global ve los suyos y los dueños posibles, sin datos de activos ni personas', async () => {
    expect((await http().get('/api/v1/cost-centers').set(auth(requester))).status).toBe(403);
    await asset(owner);
    const inactive = await center('Centro inactivo Solicitudes');
    const grouping = await center('Centro de agrupación Solicitudes');
    await dataSource.query('UPDATE cost_center SET is_active = FALSE WHERE id = $1', [inactive]);
    await dataSource.query('UPDATE cost_center SET accepts_assets = FALSE WHERE id = $1', [grouping]);
    const expired = await actor('Exjefa', ['DEPARTMENT_HEAD']);
    await dataSource.query(
      `INSERT INTO cost_center_head (person_id, cost_center_id, reason, valid_from, valid_until)
       VALUES ($1, $2, 'Prueba', NOW() - interval '2 days', NOW() - interval '1 day')`,
      [expired.personId, owner],
    );
    await dataSource.query(`INSERT INTO cost_center_head (person_id, cost_center_id, reason) VALUES ($1, $2, 'Prueba')`, [requester.personId, inactive]);

    const response = await http().get('/api/v1/asset-requests/centers').set(auth(requester)).expect(200);
    expectConforms('get', '/api/v1/asset-requests/centers', 200, response.body);
    const { headed, owners } = response.body.data as { headed: Array<Record<string, unknown>>; owners: Array<Record<string, unknown>> };
    expect(headed.map((row) => row.id)).toEqual([requesting]);
    const ownerIds = owners.map((row) => row.id);
    expect(ownerIds).toEqual(expect.arrayContaining([owner, requesting, headless]));
    expect(ownerIds).not.toContain(inactive);
    expect(ownerIds).not.toContain(grouping);
    for (const row of [...headed, ...owners]) {
      expect(Object.keys(row).sort()).toEqual(['code', 'id', 'name']);
    }
    // Una jefatura vencida no cuenta; quien no dirige nada igual ve a quién podría pedir.
    const other = (await http().get('/api/v1/asset-requests/centers').set(auth(expired)).expect(200)).body.data;
    expect(other.headed).toEqual([]);
    expect(other.owners.length).toBe(owners.length);
    await dataSource.query('DELETE FROM cost_center_head WHERE cost_center_id = $1', [inactive]);
    await dataSource.query('UPDATE user_role SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [expired.userId]);
  });

  it('solicitar: solo jefe vigente del centro que solicita; el dueño debe tener jefe (se ve antes de enviar)', async () => {
    const availability = await http().get(`/api/v1/asset-requests/owner-availability?costCenterId=${headless}`).set(auth(requester)).expect(200);
    expect(availability.body.data).toMatchObject({ hasHead: false });
    expectConforms('get', '/api/v1/asset-requests/owner-availability', 200, availability.body);
    expect((await http().get(`/api/v1/asset-requests/owner-availability?costCenterId=${owner}`).set(auth(requester)).expect(200)).body.data).toMatchObject({
      hasHead: true,
    });
    const noHead = await create(temporary({ ownerCostCenterId: headless }));
    expect([noHead.status, noHead.body.error.code]).toEqual([409, 'ASSET_REQUEST_OWNER_WITHOUT_HEAD']);
    const notHead = await create(temporary(), ownerHead);
    expect([notHead.status, notHead.body.error.code]).toEqual([403, 'ASSET_REQUEST_NOT_HEAD']);
    const noDates = await create(temporary({ startDate: undefined }));
    expect([noDates.status, noDates.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);
    const sameCenter = await create(temporary({ ownerCostCenterId: requesting }));
    expect(sameCenter.status).toBe(400);
  });

  it('préstamo: crear → elegir (lista y QR) → aceptar → devolver → corregir → generar → firmas → ACTIVE y aviso a ambos', async () => {
    const first = await asset(owner);
    const second = await asset(owner, 'IN_STORAGE');
    const damaged = await asset(owner, 'IN_MAINTENANCE');
    const foreign = await asset(requesting);
    const created = await create(temporary()).expect(201);
    expectConforms('post', '/api/v1/asset-requests', 201, created.body);
    const id = created.body.data.id as string;
    expect(created.body.data).toMatchObject({ status: 'REQUESTED', code: expect.stringMatching(/^SOL-\d{4}-\d{4}$/), assetCount: 0 });
    expect(await notices(ownerHead.userId, id)).toEqual([{ type: 'ASSET_REQUEST_CREATED' }]);
    expect(await notices(bothHead.userId, id)).toEqual([{ type: 'ASSET_REQUEST_CREATED' }]);

    // Solo el jefe dueño ve los elegibles de su centro (ni el solicitante ni otro jefe).
    const eligible = await http().get(`/api/v1/asset-requests/${id}/eligible-assets`).set(auth(ownerHead)).expect(200);
    expectConforms('get', '/api/v1/asset-requests/{id}/eligible-assets', 200, eligible.body);
    const eligibleIds = eligible.body.data.map((item: { id: string }) => item.id);
    expect(eligibleIds).toEqual(expect.arrayContaining([first, second]));
    expect(eligibleIds).not.toContain(damaged);
    expect(eligibleIds).not.toContain(foreign);
    expect((await http().get(`/api/v1/asset-requests/${id}/eligible-assets`).set(auth(requester))).status).toBe(404);

    // QR de la etiqueta: el del centro dueño se resuelve; el de otro centro, como si no existiera.
    const qrOwn = (await http().post(`/api/v1/assets/${first}/qr`).set(auth(director)).expect(201)).body.data.token as string;
    const qrForeign = (await http().post(`/api/v1/assets/${foreign}/qr`).set(auth(director)).expect(201)).body.data.token as string;
    const scanned = await http().post(`/api/v1/asset-requests/${id}/resolve-scan`).set(auth(ownerHead)).send({ token: qrOwn }).expect(200);
    expectConforms('post', '/api/v1/asset-requests/{id}/resolve-scan', 200, scanned.body);
    expect(scanned.body.data).toMatchObject({ id: first, eligible: true, reason: null });
    const foreignScan = await http().post(`/api/v1/asset-requests/${id}/resolve-scan`).set(auth(ownerHead)).send({ token: qrForeign });
    const garbageScan = await http().post(`/api/v1/asset-requests/${id}/resolve-scan`).set(auth(ownerHead)).send({ token: 'no-es-un-token' });
    expect([foreignScan.status, foreignScan.body.error]).toEqual([garbageScan.status, garbageScan.body.error]);
    expect(foreignScan.status).toBe(404);

    // Separación: quien dirige ambos centros no decide la solicitud que él mismo hizo; otro jefe del dueño sí.
    const sod = (await create(temporary(), bothHead).expect(201)).body.data.id as string;
    const selfAccept = await http().post(`/api/v1/asset-requests/${sod}/accept`).set(auth(bothHead)).send({ assetIds: [second] });
    expect([selfAccept.status, selfAccept.body.error.code]).toEqual([403, 'ASSET_REQUEST_SOD_VIOLATION']);
    const noReason = await http().post(`/api/v1/asset-requests/${sod}/close`).set(auth(ownerHead)).send({ reason: 'no' });
    expect(noReason.status).toBe(400);
    const closed = await http().post(`/api/v1/asset-requests/${sod}/close`).set(auth(ownerHead)).send({ reason: 'Equipos comprometidos' }).expect(200);
    expect(closed.body.data.status).toBe('CLOSED_BY_OWNER');
    expect(await notices(bothHead.userId, sod)).toEqual([{ type: 'ASSET_REQUEST_CLOSED' }]);

    // Aceptar con un activo ajeno: 404 como inexistente; con uno no prestable: 406 con el motivo.
    const withForeign = await http().post(`/api/v1/asset-requests/${id}/accept`).set(auth(ownerHead)).send({ assetIds: [first, foreign] });
    expect([withForeign.status, withForeign.body.error.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
    const withDamaged = await http().post(`/api/v1/asset-requests/${id}/accept`).set(auth(ownerHead)).send({ assetIds: [first, damaged] });
    expect([withDamaged.status, withDamaged.body.error.code]).toEqual([406, 'ASSET_REQUEST_ASSET_UNAVAILABLE']);
    const accepted = await http().post(`/api/v1/asset-requests/${id}/accept`).set(auth(ownerHead)).send({ assetIds: [first, second] }).expect(200);
    expectConforms('post', '/api/v1/asset-requests/{id}/accept', 200, accepted.body);
    expect(accepted.body.data).toMatchObject({ status: 'ACCEPTED', assetCount: 2, viewerRoles: ['OWNER_HEAD'] });
    expect(accepted.body.data.expiresAt).not.toBeNull();
    expect(await notices(requester.userId, id)).toEqual([{ type: 'ASSET_REQUEST_ACCEPTED' }]);
    expect(await notices(auditor.userId, id)).toEqual([{ type: 'ASSET_REQUEST_ACCEPTED' }]);
    // Reservados: no aparecen para otra solicitud.
    const other = (await create(temporary()).expect(201)).body.data.id as string;
    const otherEligible = (await http().get(`/api/v1/asset-requests/${other}/eligible-assets`).set(auth(ownerHead)).expect(200)).body.data;
    expect(otherEligible.map((item: { id: string }) => item.id)).not.toContain(first);
    await http().post(`/api/v1/asset-requests/${other}/cancel`).set(auth(requester)).send({ reason: 'Ya no se necesita' }).expect(200);

    // Control Interno devuelve; el solicitante corrige solo texto → vuelve a Control Interno con los mismos activos.
    const notReviewer = await http().post(`/api/v1/asset-requests/${id}/return`).set(auth(ownerHead)).send({ reason: 'Falta algo' });
    expect(notReviewer.status).toBe(403);
    await http().post(`/api/v1/asset-requests/${id}/return`).set(auth(auditor)).send({ reason: 'Precise el uso de los equipos' }).expect(200);
    const corrected = await http()
      .patch(`/api/v1/asset-requests/${id}`)
      .set(auth(requester))
      .send({ description: 'Dos portátiles para la inducción de octubre' })
      .expect(200);
    expect(corrected.body.data).toMatchObject({ status: 'ACCEPTED', assetCount: 2 });

    // Generar: el auditor revisa pero no tiene el permiso de generación del OCI-01-65.
    const auditorGenerate = await http().post(`/api/v1/asset-requests/${id}/generate`).set(auth(auditor)).send({ controlSignerPersonId: auditor.personId });
    expect([auditorGenerate.status, auditorGenerate.body.error.code]).toEqual([403, 'INSUFFICIENT_PERMISSIONS']);
    const generated = await http()
      .post(`/api/v1/asset-requests/${id}/generate`)
      .set(auth(director))
      .send({ controlSignerPersonId: auditor.personId, assetNotes: { [first]: 'Con cargador' } })
      .expect(200);
    expectConforms('post', '/api/v1/asset-requests/{id}/generate', 200, generated.body);
    expect(generated.body.data).toMatchObject({ status: 'DOCUMENT_GENERATED', document: { kind: 'LOAN', status: 'PENDING_SIGNATURES' } });
    const loanId = generated.body.data.document.id as string;
    const loan = await scalar<Record<string, string>>(
      dataSource,
      `SELECT row_to_json(l) FROM (SELECT status, asset_request_id, approved_by, requested_by, target_cost_center_id, source_cost_center_id FROM asset_loan WHERE id = $1) l`,
      [loanId],
    );
    expect(loan).toMatchObject({
      status: 'PENDING_SIGNATURES',
      asset_request_id: id,
      approved_by: ownerHead.userId,
      requested_by: requester.userId,
      target_cost_center_id: requesting,
      source_cost_center_id: owner,
    });
    expect(await scalar<string>(dataSource, 'SELECT operational_status::text FROM asset WHERE id = $1', [first])).toBe('ON_LOAN');
    await engine.processPending(1000);
    const act = await detail(id);
    expect(act.document.documentId).not.toBeNull();
    const signers = (await dataSource.query('SELECT sign_order, role, signer_person_id FROM document_signature WHERE document_id = $1 ORDER BY sign_order', [
      act.document.documentId,
    ])) as Array<{ sign_order: number; role: string; signer_person_id: string }>;
    expect(signers.map((row) => [row.role, row.signer_person_id])).toEqual([
      ['ENTREGA', ownerHead.personId],
      ['RECIBE', requester.personId],
      ['AUDITA', auditor.personId],
    ]);
    await sign(act.document.documentId, 1, ownerHead).expect(200);
    await sign(act.document.documentId, 2, requester).expect(200);
    await sign(act.document.documentId, 3, auditor).expect(200);
    expect(await scalar<string>(dataSource, 'SELECT status FROM asset_loan WHERE id = $1', [loanId])).toBe('ACTIVE');
    const done = await detail(id);
    expect(done.document).toMatchObject({ status: 'ACTIVE', documentStatus: 'SIGNED' });
    expect(done.events.map((event: { eventType: string }) => event.eventType)).toEqual([
      'CREATED',
      'ACCEPTED',
      'RETURNED',
      'CORRECTED',
      'DOCUMENT_GENERATED',
      'DOCUMENT_COMPLETED',
    ]);
    for (const who of [requester, ownerHead]) {
      expect((await notices(who.userId, id)).map((row) => row.type)).toContain('ASSET_REQUEST_COMPLETED');
    }
    const mail = (await dataSource.query(
      `SELECT context->>'documento.url' AS url FROM mail_outbox WHERE entity_id = $1 AND template_type = 'ASSET_REQUEST_COMPLETED'`,
      [id],
    )) as Array<{ url: string }>;
    expect(mail.length).toBeGreaterThanOrEqual(2);
    expect(mail[0]?.url).toContain(`/documents/${act.document.documentId}`);
  });

  it('traslado: aceptar → generar con los datos por activo → cuatro firmas → COMPLETED y aviso a ambos', async () => {
    const assetId = await asset(owner);
    const id = (await create(temporary({ kind: 'PERMANENT', startDate: undefined, expectedReturnDate: undefined })).expect(201)).body.data.id as string;
    await http().post(`/api/v1/asset-requests/${id}/accept`).set(auth(ownerHead)).send({ assetIds: [assetId] }).expect(200);
    const missingItems = await http().post(`/api/v1/asset-requests/${id}/generate`).set(auth(director)).send({});
    expect([missingItems.status, missingItems.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);
    const generated = await http()
      .post(`/api/v1/asset-requests/${id}/generate`)
      .set(auth(director))
      .send({
        controlSignerPersonId: auditor.personId,
        accountingSignerPersonId: accountant.personId,
        items: [{ assetId, reasonId, physicallyVerified: true, numberingPresent: true, observations: 'Sin novedad' }],
      })
      .expect(200);
    expect(generated.body.data.document).toMatchObject({ kind: 'TRANSFER', status: 'PENDING_SIGNATURES' });
    const transferId = generated.body.data.document.id as string;
    expect(await scalar<string>(dataSource, 'SELECT asset_request_id FROM asset_transfer WHERE id = $1', [transferId])).toBe(id);
    await engine.processPending(1000);
    const documentId = (await detail(id)).document.documentId as string;
    await sign(documentId, 1, ownerHead).expect(200);
    await sign(documentId, 2, requester).expect(200);
    await sign(documentId, 3, auditor).expect(200);
    await sign(documentId, 4, accountant).expect(200);
    expect(await scalar<string>(dataSource, 'SELECT current_cost_center_id FROM asset WHERE id = $1', [assetId])).toBe(requesting);
    expect((await detail(id)).document).toMatchObject({ status: 'COMPLETED', documentStatus: 'SIGNED' });
    for (const who of [requester, ownerHead]) {
      expect((await notices(who.userId, id)).map((row) => row.type)).toContain('ASSET_REQUEST_COMPLETED');
    }
  });

  it('corregir el centro dueño vuelve al dueño y descarta los activos; cancelar con motivo', async () => {
    const assetId = await asset(owner);
    const secondOwner = await center('Biblioteca Solicitudes');
    const secondHead = await actor('Bibliotecaria', ['DEPARTMENT_HEAD'], [secondOwner]);
    const id = (await create(temporary()).expect(201)).body.data.id as string;
    await http().post(`/api/v1/asset-requests/${id}/accept`).set(auth(ownerHead)).send({ assetIds: [assetId] }).expect(200);
    await http().post(`/api/v1/asset-requests/${id}/return`).set(auth(director)).send({ reason: 'Pídalo a Biblioteca' }).expect(200);
    const notRequester = await http().patch(`/api/v1/asset-requests/${id}`).set(auth(ownerHead)).send({ description: 'Otra cosa' });
    expect(notRequester.status).toBe(403);
    const moved = await http().patch(`/api/v1/asset-requests/${id}`).set(auth(requester)).send({ ownerCostCenterId: secondOwner }).expect(200);
    expect(moved.body.data).toMatchObject({ status: 'REQUESTED', assetCount: 0, ownerCostCenter: { id: secondOwner } });
    expect(await notices(secondHead.userId, id)).toEqual([{ type: 'ASSET_REQUEST_CORRECTED' }]);
    // El dueño anterior ya no es parte.
    expect((await http().get(`/api/v1/asset-requests/${id}`).set(auth(ownerHead))).status).toBe(404);
    const cancelled = await http().post(`/api/v1/asset-requests/${id}/cancel`).set(auth(requester)).send({ reason: 'Se resolvió de otra forma' }).expect(200);
    expect(cancelled.body.data.status).toBe('CANCELLED');
    await dataSource.query('UPDATE user_role SET revoked_at = NOW() WHERE user_id = $1', [secondHead.userId]);
  });

  it('vence a los 14 días sin resolución de Control Interno: EXPIRED, activos libres y aviso a los tres', async () => {
    const assetId = await asset(owner);
    const id = (await create(temporary()).expect(201)).body.data.id as string;
    const accepted = (await http().post(`/api/v1/asset-requests/${id}/accept`).set(auth(ownerHead)).send({ assetIds: [assetId] }).expect(200)).body.data;
    const days = (new Date(accepted.expiresAt).getTime() - new Date(accepted.updatedAt).getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(14);
    await dataSource.query(`UPDATE asset_request SET expires_at = NOW() - interval '1 minute' WHERE id = $1`, [id]);
    expect(await app.get(AssetRequestsService).expireDue()).toBeGreaterThanOrEqual(1);
    const expired = await detail(id);
    expect(expired).toMatchObject({ status: 'EXPIRED', items: [{ assetId, open: false }] });
    expect(expired.events.at(-1)).toMatchObject({ eventType: 'EXPIRED', actor: null });
    for (const who of [requester, ownerHead, auditor]) {
      expect((await notices(who.userId, id)).map((row) => row.type)).toContain('ASSET_REQUEST_EXPIRED');
    }
    const late = await http().post(`/api/v1/asset-requests/${id}/generate`).set(auth(director)).send({});
    expect([late.status, late.body.error.code]).toEqual([406, 'ASSET_REQUEST_INVALID_STATE_TRANSITION']);
  });

  it('bandejas: mías, por decidir y revisión (solo Control Interno)', async () => {
    const mine = (await http().get('/api/v1/asset-requests?box=mine').set(auth(requester)).expect(200)).body;
    expectConforms('get', '/api/v1/asset-requests', 200, mine);
    expect(mine.data.items.length).toBeGreaterThan(0);
    expect(mine.data.items.every((item: { requester: { userId: string } }) => item.requester.userId === requester.userId)).toBe(true);
    const toDecide = (await http().get('/api/v1/asset-requests?box=to-decide').set(auth(ownerHead)).expect(200)).body.data.items;
    expect(toDecide.every((item: { ownerCostCenter: { id: string } }) => item.ownerCostCenter.id === owner)).toBe(true);
    expect((await http().get('/api/v1/asset-requests?box=to-decide').set(auth(outsider)).expect(200)).body.data.items).toEqual([]);
    const denied = await http().get('/api/v1/asset-requests?box=review').set(auth(requester));
    expect([denied.status, denied.body.error.code]).toEqual([403, 'INSUFFICIENT_PERMISSIONS']);
    expect((await http().get('/api/v1/asset-requests?box=review&status=EXPIRED').set(auth(auditor)).expect(200)).body.data.total).toBeGreaterThan(0);
    // El rol AUDITOR de la semilla ya no trae asset_request:review:global (migración 1767225940000).
    const plainAuditor = await actor('Auditor', ['AUDITOR']);
    const notReviewer = await http().get('/api/v1/asset-requests?box=review').set(auth(plainAuditor));
    expect([notReviewer.status, notReviewer.body.error.code]).toEqual([403, 'INSUFFICIENT_PERMISSIONS']);
    await dataSource.query('UPDATE user_role SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [plainAuditor.userId]);
  });
});
