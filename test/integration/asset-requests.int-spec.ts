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

  it('préstamo: crear → elegir (lista y QR) → aceptar → devolver → corregir → generar (programado) → entregar → firmas → ACTIVE y aviso a ambos', async () => {
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
    const auditorGenerate = await http().post(`/api/v1/asset-requests/${id}/generate`).set(auth(auditor)).send({});
    expect([auditorGenerate.status, auditorGenerate.body.error.code]).toEqual([403, 'INSUFFICIENT_PERMISSIONS']);
    // Firmantes y observaciones del acta son de la entrega, no de la generación.
    const withSigners = await http()
      .post(`/api/v1/asset-requests/${id}/generate`)
      .set(auth(director))
      .send({ controlSignerPersonId: auditor.personId, assetNotes: { [first]: 'Con cargador' } });
    expect([withSigners.status, withSigners.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);
    const generated = await http().post(`/api/v1/asset-requests/${id}/generate`).set(auth(director)).send({}).expect(200);
    expectConforms('post', '/api/v1/asset-requests/{id}/generate', 200, generated.body);
    expect(generated.body.data).toMatchObject({
      status: 'LOAN_SCHEDULED',
      document: { kind: 'LOAN', status: 'APPROVED', startDate: bogotaToday(), documentId: null },
    });
    const loanId = generated.body.data.document.id as string;
    const loan = await scalar<Record<string, string>>(
      dataSource,
      `SELECT row_to_json(l) FROM (SELECT status, asset_request_id, approved_by, requested_by, target_cost_center_id, source_cost_center_id,
         to_char(start_date, 'YYYY-MM-DD') AS start_date FROM asset_loan WHERE id = $1) l`,
      [loanId],
    );
    expect(loan).toMatchObject({
      status: 'APPROVED',
      asset_request_id: id,
      approved_by: ownerHead.userId,
      requested_by: requester.userId,
      target_cost_center_id: requesting,
      source_cost_center_id: owner,
      start_date: bogotaToday(),
    });
    // Generar no entrega: los activos siguen en el dueño, sin movimiento ni acta.
    expect(await scalar<string>(dataSource, 'SELECT operational_status::text FROM asset WHERE id = $1', [first])).toBe('IN_USE');
    expect(await scalar<number>(dataSource, `SELECT count(*)::int FROM asset_movement WHERE asset_id = $1 AND movement_type::text = 'LOAN'`, [first])).toBe(0);
    expect(
      await scalar<number>(dataSource, `SELECT count(*)::int FROM document_request WHERE payload->>'entityType' = 'LOAN' AND payload->>'entityId' = $1`, [loanId]),
    ).toBe(0);
    for (const who of [requester, ownerHead]) {
      expect((await notices(who.userId, id)).map((row) => row.type)).toContain('ASSET_REQUEST_LOAN_SCHEDULED');
    }
    // Entrega: el jefe dueño (sin loan:update:global), desde la fecha de inicio (hoy).
    const delivered = await http()
      .post(`/api/v1/loans/${loanId}/deliver`)
      .set(auth(ownerHead))
      .send({ deliveredByPersonId: ownerHead.personId, controlInternoPersonId: auditor.personId, assetNotes: { [first]: 'Con cargador' } })
      .expect(200);
    expect(delivered.body.data).toMatchObject({ status: 'PENDING_SIGNATURES', startDate: bogotaToday() });
    expect(await scalar<string>(dataSource, 'SELECT operational_status::text FROM asset WHERE id = $1', [first])).toBe('ON_LOAN');
    expect(await scalar<string>(dataSource, 'SELECT status FROM asset_request WHERE id = $1', [id])).toBe('DOCUMENT_GENERATED');
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
      'LOAN_SCHEDULED',
      'LOAN_DELIVERED',
      'DOCUMENT_COMPLETED',
    ]);
    expect(done.events.find((event: { eventType: string }) => event.eventType === 'LOAN_DELIVERED')).toMatchObject({
      fromStatus: 'LOAN_SCHEDULED',
      toStatus: 'DOCUMENT_GENERATED',
      actor: { userId: ownerHead.userId },
    });
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

  it('firmante de Control Interno: quien genera el préstamo (loan:update:global) ve la lista neutral y la entrega valida contra ella', async () => {
    const loanReviewer = await actor('Revisora de préstamos', [
      await createPermissionRole(dataSource, ['loan:update:global', 'asset_request:review:global'], 'IT_PRESTAMOS'),
    ]);
    const loanOnly = await actor('Gestora de préstamos', [await createPermissionRole(dataSource, ['loan:update:global'], 'IT_PRESTAMOS')]);
    const nobody = await actor('Sin permisos', []);
    const expected = (await dataSource.query(
      `SELECT DISTINCT p.id AS "personId" FROM v_user_effective_permissions v
       JOIN app_user u ON u.id = v.user_id AND u.status = 'ACTIVE' JOIN person p ON p.id = u.person_id AND p.is_active
       WHERE v.permission_code = 'act:sign_control:global'`,
    )) as Array<{ personId: string }>;
    expect(expected.length).toBeGreaterThan(1);

    // La lista de /transfers exige asset:update:global; la neutral acepta cualquier permiso de generación o la revisión.
    expect((await http().get('/api/v1/transfers/control-signers').set(auth(loanOnly))).status).toBe(403);
    const listed = await http().get('/api/v1/documents/control-signers').set(auth(loanOnly)).expect(200);
    expectConforms('get', '/api/v1/documents/control-signers', 200, listed.body);
    const ids = (listed.body.data as Array<{ personId: string; name: string }>).map((row) => row.personId);
    expect([...ids].sort()).toEqual(expected.map((row) => row.personId).sort());
    expect(ids).toEqual(expect.arrayContaining([director.personId, auditor.personId]));
    expect(ids).not.toContain(requester.personId);
    for (const row of listed.body.data as Array<Record<string, unknown>>) {
      expect(Object.keys(row).sort()).toEqual(['name', 'personId']);
    }
    // Revisar solicitudes basta (el auditor no genera préstamos); sin ninguno de esos permisos, 403.
    expect((await http().get('/api/v1/documents/control-signers').set(auth(auditor)).expect(200)).body.data).toEqual(listed.body.data);
    const denied = await http().get('/api/v1/documents/control-signers').set(auth(nobody));
    expect([denied.status, denied.body.error.code]).toEqual([403, 'INSUFFICIENT_PERMISSIONS']);
    // Mismo contenido que la lista de traslados.
    expect((await http().get('/api/v1/transfers/control-signers').set(auth(director)).expect(200)).body.data).toEqual(listed.body.data);

    // Préstamo de una solicitud: se genera sin firmantes; al entregar, fuera de la lista → no elegible (nada se mueve);
    // de la lista → se usa. Quien genera (loan:update:global) también puede entregar.
    const assetId = await asset(owner);
    const id = (await create(temporary()).expect(201)).body.data.id as string;
    await http().post(`/api/v1/asset-requests/${id}/accept`).set(auth(ownerHead)).send({ assetIds: [assetId] }).expect(200);
    const generated = await http().post(`/api/v1/asset-requests/${id}/generate`).set(auth(loanReviewer)).send({}).expect(200);
    expect(generated.body.data).toMatchObject({ status: 'LOAN_SCHEDULED', document: { kind: 'LOAN', status: 'APPROVED' } });
    const loanId = generated.body.data.document.id as string;
    const outside = await http()
      .post(`/api/v1/loans/${loanId}/deliver`)
      .set(auth(loanReviewer))
      .send({ deliveredByPersonId: ownerHead.personId, controlInternoPersonId: loanOnly.personId });
    expect([outside.status, outside.body.error.code]).toEqual([400, 'DOCUMENT_SIGNER_NOT_ELIGIBLE']);
    expect(await scalar<string>(dataSource, 'SELECT operational_status::text FROM asset WHERE id = $1', [assetId])).toBe('IN_USE');
    expect(await scalar<string>(dataSource, 'SELECT status FROM asset_request WHERE id = $1', [id])).toBe('LOAN_SCHEDULED');
    const chosen = ids.find((personId) => personId === auditor.personId) ?? '';
    await http()
      .post(`/api/v1/loans/${loanId}/deliver`)
      .set(auth(loanReviewer))
      .send({ deliveredByPersonId: ownerHead.personId, controlInternoPersonId: chosen })
      .expect(200);
    await engine.processPending(1000);
    const documentId = (await detail(id)).document.documentId as string;
    expect(
      await scalar<string>(dataSource, `SELECT signer_person_id FROM document_signature WHERE document_id = $1 AND role = 'AUDITA'`, [documentId]),
    ).toBe(auditor.personId);
    await dataSource.query('UPDATE user_role SET revoked_at = NOW() WHERE user_id = ANY($1) AND revoked_at IS NULL', [
      [loanReviewer.userId, loanOnly.userId, nobody.userId],
    ]);
  });

  it('entrega por el jefe dueño sin permisos generales: opciones acotadas al préstamo, ENTREGA = él mismo, AUDITA de la lista', async () => {
    // Jefe vigente del centro dueño y nada más: ni loan:update, ni asset:update, ni /persons, ni la lista general de firmantes.
    const plainHead = await actor('Jefa sin permisos', [], [owner]);
    const assetId = await asset(owner);
    const id = (await create(temporary()).expect(201)).body.data.id as string;
    await http().post(`/api/v1/asset-requests/${id}/accept`).set(auth(plainHead)).send({ assetIds: [assetId] }).expect(200);
    const loanId = (await http().post(`/api/v1/asset-requests/${id}/generate`).set(auth(director)).send({}).expect(200)).body.data.document
      .id as string;
    expect((await http().get('/api/v1/persons').set(auth(plainHead))).status).toBe(403);
    expect((await http().get('/api/v1/documents/control-signers').set(auth(plainHead))).status).toBe(403);
    expect((await http().get(`/api/v1/loans/${loanId}`).set(auth(plainHead))).status).toBe(403);

    const options = await http().get(`/api/v1/loans/${loanId}/delivery-options`).set(auth(plainHead)).expect(200);
    expectConforms('get', '/api/v1/loans/{id}/delivery-options', 200, options.body);
    const data = options.body.data as {
      deliverer: { personId: string; name: string } | null;
      controlSigners: Array<{ personId: string; name: string }>;
      receiver: { personId: string; name: string } | null;
      items: Array<Record<string, unknown>>;
    };
    expect(options.body.data).toMatchObject({ loanId, status: 'APPROVED', startDate: bogotaToday(), canDeliverNow: true });
    expect(data.deliverer).toEqual({ personId: plainHead.personId, name: 'Jefa sin permisos Solicitud' });
    expect(data.receiver).toEqual({ personId: requester.personId, name: 'Solicitante Solicitud' });
    expect(data.items).toEqual([{ assetId, code: expect.stringMatching(/^SOL-/), description: expect.stringContaining('PORTATIL') }]);
    const listed = (await http().get('/api/v1/documents/control-signers').set(auth(director)).expect(200)).body.data;
    expect(data.controlSigners).toEqual(listed);
    expect(data.controlSigners.length).toBeGreaterThan(1);

    // Nadie más ve las opciones: otro jefe, el solicitante, un préstamo inexistente → 404 idéntico.
    const missing = await http().get(`/api/v1/loans/${randomUUID()}/delivery-options`).set(auth(plainHead));
    for (const who of [outsider, requester]) {
      const denied = await http().get(`/api/v1/loans/${loanId}/delivery-options`).set(auth(who));
      expect([denied.status, denied.body.error.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
    }
    expect([missing.status, missing.body.error.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
    // Control Interno: ENTREGA la elige él (deliverer null).
    expect((await http().get(`/api/v1/loans/${loanId}/delivery-options`).set(auth(director)).expect(200)).body.data.deliverer).toBeNull();

    // ENTREGA no se delega; AUDITA es obligatorio con varias personas en la lista. Nada se mueve.
    const other = await http()
      .post(`/api/v1/loans/${loanId}/deliver`)
      .set(auth(plainHead))
      .send({ deliveredByPersonId: ownerHead.personId, controlInternoPersonId: auditor.personId });
    expect([other.status, other.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);
    expect(other.body.error.details).toEqual([expect.objectContaining({ field: 'deliveredByPersonId' })]);
    const noAudit = await http().post(`/api/v1/loans/${loanId}/deliver`).set(auth(plainHead)).send({});
    expect([noAudit.status, noAudit.body.error.code]).toEqual([400, 'TRANSFER_SIGNER_REQUIRED']);
    expect(await scalar<string>(dataSource, 'SELECT operational_status::text FROM asset WHERE id = $1', [assetId])).toBe('IN_USE');

    const chosen = data.controlSigners.find((row) => row.personId === auditor.personId)?.personId ?? '';
    const delivered = await http()
      .post(`/api/v1/loans/${loanId}/deliver`)
      .set(auth(plainHead))
      .send({ controlInternoPersonId: chosen, assetNotes: { [assetId]: 'Con cargador' } })
      .expect(200);
    expect(delivered.body.data.status).toBe('PENDING_SIGNATURES');
    expect(await scalar<string>(dataSource, 'SELECT status FROM asset_request WHERE id = $1', [id])).toBe('DOCUMENT_GENERATED');
    await engine.processPending(1000);
    const documentId = (await detail(id)).document.documentId as string;
    const signers = (await dataSource.query('SELECT role, signer_person_id FROM document_signature WHERE document_id = $1 ORDER BY sign_order', [
      documentId,
    ])) as Array<{ role: string; signer_person_id: string }>;
    expect(signers.map((row) => [row.role, row.signer_person_id])).toEqual([
      ['ENTREGA', plainHead.personId],
      ['RECIBE', requester.personId],
      ['AUDITA', auditor.personId],
    ]);
    // Ya entregado: las opciones dicen que no se puede entregar hoy.
    expect((await http().get(`/api/v1/loans/${loanId}/delivery-options`).set(auth(plainHead)).expect(200)).body.data.canDeliverNow).toBe(false);
    await dataSource.query('UPDATE cost_center_head SET valid_until = NOW() WHERE person_id = $1', [plainHead.personId]);
  });

  it('préstamo programado rechazado: la solicitud se cierra con el motivo, libera los activos y avisa como un vencimiento', async () => {
    const assetId = await asset(owner);
    const id = (await create(temporary({ startDate: plusDays(2), expectedReturnDate: plusDays(9) })).expect(201)).body.data.id as string;
    await http().post(`/api/v1/asset-requests/${id}/accept`).set(auth(ownerHead)).send({ assetIds: [assetId] }).expect(200);
    const loanId = (await http().post(`/api/v1/asset-requests/${id}/generate`).set(auth(director)).send({}).expect(200)).body.data.document
      .id as string;
    const rejected = await http()
      .post(`/api/v1/loans/${loanId}/reject`)
      .set(auth(director))
      .send({ reason: 'Los equipos se necesitan para el cierre del semestre' })
      .expect(200);
    expect(rejected.body.data).toMatchObject({ status: 'REJECTED', rejectedReason: 'Los equipos se necesitan para el cierre del semestre' });

    const closed = await detail(id);
    expect(closed).toMatchObject({ status: 'CLOSED_LOAN_REJECTED', expiresAt: null, document: { kind: 'LOAN', id: loanId, status: 'REJECTED' } });
    expect(closed.events.at(-1)).toMatchObject({
      eventType: 'LOAN_REJECTED',
      fromStatus: 'LOAN_SCHEDULED',
      toStatus: 'CLOSED_LOAN_REJECTED',
      reason: 'Los equipos se necesitan para el cierre del semestre',
      actor: { userId: director.userId },
      payload: { loanId },
    });
    expectConforms('get', '/api/v1/asset-requests/{id}', 200, (await http().get(`/api/v1/asset-requests/${id}`).set(auth(requester)).expect(200)).body);
    for (const who of [requester, ownerHead, auditor]) {
      expect((await notices(who.userId, id)).map((row) => row.type)).toContain('ASSET_REQUEST_LOAN_REJECTED');
    }
    const mail = (await dataSource.query(
      `SELECT context->>'solicitud.motivo' AS reason FROM mail_outbox WHERE entity_id = $1 AND template_type = 'ASSET_REQUEST_LOAN_REJECTED'`,
      [id],
    )) as Array<{ reason: string }>;
    expect(mail.length).toBeGreaterThanOrEqual(3);
    expect(new Set(mail.map((row) => row.reason))).toEqual(new Set(['Los equipos se necesitan para el cierre del semestre']));

    // Activos libres: vuelven a ser elegibles; el préstamo rechazado ya no se entrega.
    const next = (await create(temporary()).expect(201)).body.data.id as string;
    const eligible = (await http().get(`/api/v1/asset-requests/${next}/eligible-assets`).set(auth(ownerHead)).expect(200)).body.data;
    expect(eligible.map((item: { id: string }) => item.id)).toContain(assetId);
    await http().post(`/api/v1/asset-requests/${next}/cancel`).set(auth(requester)).send({ reason: 'Ya no se necesita' }).expect(200);
    const late = await http().post(`/api/v1/loans/${loanId}/deliver`).set(auth(director)).send({ deliveredByPersonId: ownerHead.personId, controlInternoPersonId: auditor.personId });
    expect(late.status).toBe(406);
    expect(await scalar<string>(dataSource, 'SELECT operational_status::text FROM asset WHERE id = $1', [assetId])).toBe('IN_USE');
  });

  it('préstamo programado cancelado: el solicitante, el jefe dueño o Control Interno; la solicitud se cierra con el motivo, libera los activos y avisa; entregado ya no se cancela', async () => {
    const scheduled = async () => {
      const assetId = await asset(owner);
      const id = (await create(temporary({ startDate: plusDays(2), expectedReturnDate: plusDays(9) })).expect(201)).body.data.id as string;
      await http().post(`/api/v1/asset-requests/${id}/accept`).set(auth(ownerHead)).send({ assetIds: [assetId] }).expect(200);
      const loanId = (await http().post(`/api/v1/asset-requests/${id}/generate`).set(auth(director)).send({}).expect(200)).body.data.document
        .id as string;
      return { assetId, id, loanId };
    };
    const cancel = (loanId: string, who: Actor, reason = 'El solicitante ya no necesita los equipos') =>
      http().post(`/api/v1/loans/${loanId}/cancel`).set(auth(who)).send({ reason });

    // 1. El solicitante cancela (es quien sabe que ya no lo necesita).
    const first = await scheduled();
    expect((await cancel(first.loanId, outsider)).status).toBe(403);
    expect((await cancel(first.loanId, auditor)).status).toBe(403);
    const short = await cancel(first.loanId, requester, 'no');
    expect([short.status, short.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);
    const cancelled = await cancel(first.loanId, requester);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expectConforms('post', '/api/v1/loans/{id}/cancel', 200, cancelled.body);
    expect(cancelled.body.data).toMatchObject({
      status: 'CANCELLED',
      cancelledReason: 'El solicitante ya no necesita los equipos',
      rejectedReason: null,
    });
    expect((cancelled.body.data.events as Array<{ eventType: string; payload: unknown }>).at(-1)).toMatchObject({
      eventType: 'CANCELLED',
      payload: { reason: 'El solicitante ya no necesita los equipos' },
    });
    const closed = await detail(first.id);
    expect(closed).toMatchObject({ status: 'CLOSED_LOAN_CANCELLED', expiresAt: null, document: { kind: 'LOAN', id: first.loanId } });
    expect(closed.events.at(-1)).toMatchObject({
      eventType: 'LOAN_CANCELLED',
      fromStatus: 'LOAN_SCHEDULED',
      toStatus: 'CLOSED_LOAN_CANCELLED',
      reason: 'El solicitante ya no necesita los equipos',
      actor: { userId: requester.userId },
      payload: { loanId: first.loanId },
    });
    expectConforms('get', '/api/v1/asset-requests/{id}', 200, (await http().get(`/api/v1/asset-requests/${first.id}`).set(auth(requester)).expect(200)).body);
    for (const who of [requester, ownerHead, auditor]) {
      expect((await notices(who.userId, first.id)).map((row) => row.type)).toContain('ASSET_REQUEST_LOAN_CANCELLED');
    }
    const mail = (await dataSource.query(
      `SELECT context->>'solicitud.motivo' AS reason FROM mail_outbox WHERE entity_id = $1 AND template_type = 'ASSET_REQUEST_LOAN_CANCELLED'`,
      [first.id],
    )) as Array<{ reason: string }>;
    expect(mail.length).toBeGreaterThanOrEqual(3);
    expect(new Set(mail.map((row) => row.reason))).toEqual(new Set(['El solicitante ya no necesita los equipos']));
    const [audit] = (await dataSource.query(
      `SELECT changes FROM audit_log WHERE entity_type = 'LOAN' AND entity_id = $1 AND action = 'LOAN_CANCELLED'`,
      [first.loanId],
    )) as Array<{ changes: Record<string, unknown> }>;
    expect(audit?.changes).toEqual({ from: 'APPROVED', to: 'CANCELLED' });
    // Activos libres y sin moverse; un cancelado no se vuelve a cancelar ni se entrega.
    expect(await scalar<string>(dataSource, 'SELECT operational_status::text FROM asset WHERE id = $1', [first.assetId])).toBe('IN_USE');
    const next = (await create(temporary()).expect(201)).body.data.id as string;
    const eligible = (await http().get(`/api/v1/asset-requests/${next}/eligible-assets`).set(auth(ownerHead)).expect(200)).body.data;
    expect(eligible.map((item: { id: string }) => item.id)).toContain(first.assetId);
    await http().post(`/api/v1/asset-requests/${next}/cancel`).set(auth(requester)).send({ reason: 'Ya no se necesita' }).expect(200);
    expect([(await cancel(first.loanId, director)).status, (await cancel(first.loanId, director)).body.error.code]).toEqual([
      406,
      'INVALID_LOAN_STATE_TRANSITION',
    ]);

    // 2. El jefe del centro dueño también cancela (el activo se dañó).
    const second = await scheduled();
    expect((await cancel(second.loanId, ownerHead, 'El equipo se dañó antes de la entrega')).status).toBe(200);
    expect((await detail(second.id)).status).toBe('CLOSED_LOAN_CANCELLED');

    // 3. Entregado ya no se cancela (se deshace la entrega); Control Interno sí cancela uno programado.
    const third = await scheduled();
    await dataSource.query('UPDATE asset_loan SET start_date = $2 WHERE id = $1', [third.loanId, bogotaToday()]);
    const delivered = await http()
      .post(`/api/v1/loans/${third.loanId}/deliver`)
      .set(auth(director))
      .send({ deliveredByPersonId: ownerHead.personId, controlInternoPersonId: auditor.personId });
    expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);
    const late = await cancel(third.loanId, director);
    expect([late.status, late.body.error.code]).toEqual([406, 'INVALID_LOAN_STATE_TRANSITION']);
    const fourth = await scheduled();
    expect((await cancel(fourth.loanId, director, 'Control Interno cancela el préstamo programado')).status).toBe(200);
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

  it('préstamo con fecha futura: generar no entrega; antes de la fecha no se entrega; el día de inicio se avisa una vez y se entrega con fecha real', async () => {
    const assetId = await asset(owner);
    const start = plusDays(3);
    const id = (await create(temporary({ startDate: start, expectedReturnDate: plusDays(10) })).expect(201)).body.data.id as string;
    await http().post(`/api/v1/asset-requests/${id}/accept`).set(auth(ownerHead)).send({ assetIds: [assetId] }).expect(200);
    const generated = (await http().post(`/api/v1/asset-requests/${id}/generate`).set(auth(director)).send({}).expect(200)).body.data;
    expect(generated).toMatchObject({ status: 'LOAN_SCHEDULED', document: { kind: 'LOAN', status: 'APPROVED', startDate: start, documentId: null } });
    const loanId = generated.document.id as string;
    const movementCount = () =>
      scalar<number>(dataSource, `SELECT count(*)::int FROM asset_movement WHERE asset_id = $1 AND movement_type::text = 'LOAN'`, [assetId]);
    const actCount = () =>
      scalar<number>(dataSource, `SELECT count(*)::int FROM document_request WHERE payload->>'entityType' = 'LOAN' AND payload->>'entityId' = $1`, [loanId]);
    expect(await scalar<string>(dataSource, 'SELECT operational_status::text FROM asset WHERE id = $1', [assetId])).toBe('IN_USE');
    expect(await movementCount()).toBe(0);
    expect(await actCount()).toBe(0);

    // Reservado por el préstamo APPROVED: no se elige en otra solicitud ni entra en otro préstamo.
    const other = (await create(temporary()).expect(201)).body.data.id as string;
    const otherEligible = (await http().get(`/api/v1/asset-requests/${other}/eligible-assets`).set(auth(ownerHead)).expect(200)).body.data;
    expect(otherEligible.map((item: { id: string }) => item.id)).not.toContain(assetId);
    const reserved = await http().post(`/api/v1/asset-requests/${other}/accept`).set(auth(ownerHead)).send({ assetIds: [assetId] });
    expect([reserved.status, reserved.body.error.code]).toEqual([406, 'ASSET_REQUEST_ASSET_UNAVAILABLE']);
    await http().post(`/api/v1/asset-requests/${other}/cancel`).set(auth(requester)).send({ reason: 'Ya no se necesita' }).expect(200);

    // Quién entrega: ni otro jefe ni el solicitante; el jefe dueño sí, pero no antes de la fecha.
    const body = { deliveredByPersonId: ownerHead.personId, controlInternoPersonId: director.personId };
    for (const who of [outsider, requester]) {
      const denied = await http().post(`/api/v1/loans/${loanId}/deliver`).set(auth(who)).send(body);
      expect([denied.status, denied.body.error.code]).toEqual([403, 'INSUFFICIENT_PERMISSIONS']);
    }
    const early = await http().post(`/api/v1/loans/${loanId}/deliver`).set(auth(ownerHead)).send(body);
    expect([early.status, early.body.error.code]).toEqual([409, 'LOAN_NOT_STARTED']);
    expect(early.body.error.message).toContain(start);
    expect(early.body.error.details).toEqual([{ field: 'startDate', message: start }]);
    const earlyDirector = await http().post(`/api/v1/loans/${loanId}/deliver`).set(auth(director)).send(body);
    expect([earlyDirector.status, earlyDirector.body.error.code]).toEqual([409, 'LOAN_NOT_STARTED']);
    expect(await scalar<string>(dataSource, 'SELECT operational_status::text FROM asset WHERE id = $1', [assetId])).toBe('IN_USE');
    expect(await movementCount()).toBe(0);
    expect(await actCount()).toBe(0);

    // Aviso del día de inicio: nada antes de la fecha; llegado el día, una sola vez aunque el job corra de nuevo.
    const service = app.get(AssetRequestsService);
    const startNotices = async () =>
      (await notices(requester.userId, id)).filter((row) => row.type === 'ASSET_REQUEST_LOAN_STARTS').length +
      (await notices(ownerHead.userId, id)).filter((row) => row.type === 'ASSET_REQUEST_LOAN_STARTS').length;
    await service.noticeLoanStarts();
    expect(await startNotices()).toBe(0);
    // Llega el día: se simula moviendo la fecha de inicio a hoy.
    await dataSource.query('UPDATE asset_loan SET start_date = $2 WHERE id = $1', [loanId, bogotaToday()]);
    await dataSource.query('UPDATE asset_request SET start_date = $2 WHERE id = $1', [id, bogotaToday()]);
    expect(await service.noticeLoanStarts()).toBeGreaterThanOrEqual(1);
    expect(await startNotices()).toBe(2);
    await service.noticeLoanStarts();
    expect(await startNotices()).toBe(2);
    expect(
      await scalar<number>(dataSource, `SELECT count(*)::int FROM asset_request_event WHERE request_id = $1 AND event_type = 'LOAN_START_NOTICE'`, [id]),
    ).toBe(1);
    // El aviso no entrega nada.
    expect(await scalar<string>(dataSource, 'SELECT status FROM asset_loan WHERE id = $1', [loanId])).toBe('APPROVED');

    const before = new Date(Date.now() - 1000);
    const delivered = await http().post(`/api/v1/loans/${loanId}/deliver`).set(auth(ownerHead)).send(body).expect(200);
    expect(delivered.body.data.status).toBe('PENDING_SIGNATURES');
    expect(await scalar<string>(dataSource, 'SELECT operational_status::text FROM asset WHERE id = $1', [assetId])).toBe('ON_LOAN');
    const executedAt = await scalar<Date>(
      dataSource,
      `SELECT executed_at FROM asset_movement WHERE asset_id = $1 AND movement_type::text = 'LOAN'`,
      [assetId],
    );
    expect(new Date(executedAt).getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(await actCount()).toBe(1);
    const after = await detail(id);
    expect(after.status).toBe('DOCUMENT_GENERATED');
    expect(after.events.map((event: { eventType: string }) => event.eventType)).toEqual([
      'CREATED',
      'ACCEPTED',
      'LOAN_SCHEDULED',
      'LOAN_START_NOTICE',
      'LOAN_DELIVERED',
    ]);
    // Entregado: un segundo intento ya no es una transición válida.
    const again = await http().post(`/api/v1/loans/${loanId}/deliver`).set(auth(ownerHead)).send(body);
    expect(again.status).toBe(406);
  });

  it('una solicitud devuelta vence a los 14 días de la devolución: EXPIRED, activos libres, motivo y vencimiento en el historial', async () => {
    const assetId = await asset(owner);
    const id = (await create(temporary()).expect(201)).body.data.id as string;
    await http().post(`/api/v1/asset-requests/${id}/accept`).set(auth(ownerHead)).send({ assetIds: [assetId] }).expect(200);
    const returned = (
      await http().post(`/api/v1/asset-requests/${id}/return`).set(auth(director)).send({ reason: 'Falta el uso de los equipos' }).expect(200)
    ).body.data;
    expect(returned.status).toBe('RETURNED');
    expect(returned.expiresAt).not.toBeNull();
    const days = (new Date(returned.expiresAt).getTime() - new Date(returned.updatedAt).getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(14);
    await dataSource.query(`UPDATE asset_request SET expires_at = NOW() - interval '1 minute' WHERE id = $1`, [id]);
    expect(await app.get(AssetRequestsService).expireDue()).toBeGreaterThanOrEqual(1);
    const expired = await detail(id);
    expect(expired).toMatchObject({ status: 'EXPIRED', items: [{ assetId, open: false }] });
    const history = expired.events as Array<{ eventType: string; fromStatus: string | null; reason: string | null; payload: Record<string, unknown> }>;
    expect(history.find((event) => event.eventType === 'RETURNED')).toMatchObject({ reason: 'Falta el uso de los equipos' });
    expect(history.at(-1)).toMatchObject({
      eventType: 'EXPIRED',
      fromStatus: 'RETURNED',
      actor: null,
      payload: { expiredFrom: 'RETURNED', returnReason: 'Falta el uso de los equipos' },
    });
    for (const who of [requester, ownerHead, director]) {
      expect((await notices(who.userId, id)).map((row) => row.type)).toContain('ASSET_REQUEST_EXPIRED');
    }
    // El activo quedó libre: vuelve a ser elegible.
    const next = (await create(temporary()).expect(201)).body.data.id as string;
    const eligible = (await http().get(`/api/v1/asset-requests/${next}/eligible-assets`).set(auth(ownerHead)).expect(200)).body.data;
    expect(eligible.map((item: { id: string }) => item.id)).toContain(assetId);
    await http().post(`/api/v1/asset-requests/${next}/cancel`).set(auth(requester)).send({ reason: 'Ya no se necesita' }).expect(200);
    const late = await http().patch(`/api/v1/asset-requests/${id}`).set(auth(requester)).send({ description: 'Tarde' });
    expect(late.status).toBe(406);
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
  });

  it('el AUDITOR de la semilla ve todas las solicitudes (asset_request:read:global) y no puede hacer ninguna acción', async () => {
    const plainAuditor = await actor('Auditor', ['AUDITOR']);
    const all = (await http().get('/api/v1/asset-requests?box=review').set(auth(plainAuditor)).expect(200)).body;
    expectConforms('get', '/api/v1/asset-requests', 200, all);
    const total = await scalar<number>(dataSource, 'SELECT count(*)::int FROM asset_request');
    expect(all.data.total).toBe(total);
    // Una en cada estado accionable: REQUESTED (dueño), ACCEPTED (Control Interno), RETURNED (solicitante).
    const assetId = await asset(owner);
    const requested = (await create(temporary()).expect(201)).body.data.id as string;
    const accepted = (await create(temporary()).expect(201)).body.data.id as string;
    await http().post(`/api/v1/asset-requests/${accepted}/accept`).set(auth(ownerHead)).send({ assetIds: [assetId] }).expect(200);
    const read = await http().get(`/api/v1/asset-requests/${accepted}`).set(auth(plainAuditor)).expect(200);
    expectConforms('get', '/api/v1/asset-requests/{id}', 200, read.body);
    expect(read.body.data.viewerRoles).toEqual(['READER']);
    const attempts: Array<[string, string, Record<string, unknown>]> = [
      ['post', `/api/v1/asset-requests/${requested}/accept`, { assetIds: [assetId] }],
      ['post', `/api/v1/asset-requests/${requested}/close`, { reason: 'No se puede' }],
      ['post', `/api/v1/asset-requests/${requested}/cancel`, { reason: 'No se puede' }],
      ['patch', `/api/v1/asset-requests/${requested}`, { description: 'Otra cosa' }],
      ['post', `/api/v1/asset-requests/${accepted}/return`, { reason: 'No se puede' }],
      ['post', `/api/v1/asset-requests/${accepted}/generate`, {}],
      ['post', '/api/v1/asset-requests', temporary()],
    ];
    for (const [method, path, payload] of attempts) {
      const response = await (method === 'patch' ? http().patch(path) : http().post(path)).set(auth(plainAuditor)).send(payload);
      expect(response.status, `${method.toUpperCase()} ${path}`).toBe(403);
    }
    expect(await scalar<string>(dataSource, 'SELECT status FROM asset_request WHERE id = $1', [requested])).toBe('REQUESTED');
    expect(await scalar<string>(dataSource, 'SELECT status FROM asset_request WHERE id = $1', [accepted])).toBe('ACCEPTED');
    // Los activos del dueño y el QR siguen siendo solo del jefe dueño.
    expect((await http().get(`/api/v1/asset-requests/${requested}/eligible-assets`).set(auth(plainAuditor))).status).toBe(404);

    // Menú: lo ven quien lee todas, quien revisa y quien solicita.
    const menuPaths = async (who: Actor) =>
      ((await http().get('/api/v1/auth/me').set(auth(who)).expect(200)).body.data.navigation as Array<{ path: string }>).map((item) => item.path);
    for (const who of [plainAuditor, director, requester]) {
      expect(await menuPaths(who)).toContain('/asset-requests');
    }
    expect(await menuPaths(await actor('Sin rol', []))).not.toContain('/asset-requests');
    await http().post(`/api/v1/asset-requests/${requested}/cancel`).set(auth(requester)).send({ reason: 'Fin de la prueba' }).expect(200);
    await dataSource.query('UPDATE user_role SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [plainAuditor.userId]);
  });
});
