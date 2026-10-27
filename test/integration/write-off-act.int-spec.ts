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
import { AssetTimelineService } from '../../src/modules/assets/services/asset-timeline.service.js';
import { TokenService } from '../../src/modules/auth/services/token.service.js';
import { PDF_CONVERTER } from '../../src/modules/documents/pdf/pdf-converter.js';
import { DocumentEngineService } from '../../src/modules/documents/services/document-engine.service.js';
import { DocumentFormatCatalogService } from '../../src/modules/documents/services/document-format-catalog.service.js';
import { GLOBAL_COST_CENTER_SCOPE } from '../../src/modules/roles/services/cost-center-scope.js';
import { conform, type Schema } from './openapi-conform.js';
import { assignTestHead, createPermissionRole, scalar, useSharedStorage } from './helpers.js';
import { DocxTextPdfConverter } from './pdf-text.js';

const FORMAT = 'OCI-17-90-BAJA';
const TEMPLATE = 'templates/formats/OCI-17-90-BAJA-v1.docx';

interface Actor {
  userId: string;
  personId: string;
  token: string;
  name: string;
}

describe('Baja de activos con acta OCI-17-90 (HTTP real + PostgreSQL real)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let engine: DocumentEngineService;
  let openapi: OpenAPIObject;
  let director: Actor;
  let auditor: Actor;
  let accountant: Actor;
  let keeper: Actor;
  let receiver: Actor;
  let outsider: Actor;
  let scopedReader: Actor;
  let rubric: string;
  let center = '';
  let other = '';
  let categoryId = '';
  let reasonId = '';
  let templateId = '';
  let sequenceBefore: string | undefined;

  const http = () => request(app.getHttpServer());
  const auth = (who: Actor) => ({ Authorization: `Bearer ${who.token}` });

  const grant = (userId: string, role: string, scopeId?: string) =>
    dataSource.query(
      `INSERT INTO user_role (user_id, role_id, scope_type, scope_id)
       SELECT $1, id, CASE WHEN $3::uuid IS NULL THEN 'GLOBAL' ELSE 'COST_CENTER' END, $3 FROM role WHERE code = $2`,
      [userId, role, scopeId ?? null],
    );

  const actor = async (first: string, options: { mfa: boolean; role?: string; scopeId?: string }): Promise<Actor> => {
    const tag = randomUUID().slice(0, 8);
    const personId = await scalar<string>(
      dataSource,
      `INSERT INTO person (first_name, last_name, email, document_type, document_number, position_title)
       VALUES ($1, 'Baja', $2, 'CC', $3, 'Funcionario de prueba') RETURNING id`,
      [first, `baja.${tag}@unac.edu.co`, `8${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 1000)}`],
    );
    const userId = await scalar<string>(
      dataSource,
      `INSERT INTO app_user (person_id, username, password_hash, mfa_enabled, status) VALUES ($1, $2, 'x', $3, 'ACTIVE') RETURNING id`,
      [personId, `baja.${tag}`, options.mfa],
    );
    if (options.role) {
      await grant(userId, options.role, options.scopeId);
    }
    const sessionId = randomUUID();
    await dataSource.query(
      `INSERT INTO refresh_token_family (id, user_id, current_jti, expires_at, mfa_verified_at)
       VALUES ($1, $2, $3, NOW() + interval '1 day', (SELECT CASE WHEN mfa_enabled THEN NOW() END FROM app_user WHERE id = $2))`,
      [sessionId, userId, randomUUID()],
    );
    const token = app.get(TokenService).signAccessToken({
      id: userId,
      personId,
      username: `baja.${tag}`,
      roles: [],
      scopes: [],
      mustChangePassword: false,
      sessionId,
    });
    return { userId, personId, token, name: `${first} Baja` };
  };

  const asset = async (costCenterId = center, price = 1500000) => {
    const tag = randomUUID().slice(0, 8).toUpperCase();
    return scalar<string>(
      dataSource,
      `INSERT INTO asset (internal_code, description, category_id, acquisition_type_id, acquisition_date, acquisition_document,
         acquisition_price, model, serial_number, current_cost_center_id, created_by, physical_condition)
       VALUES ($1, $2, $3, (SELECT id FROM acquisition_type WHERE code = 'PURCHASE'), '2019-03-10', 'IC-740', $6, 'M-1', 'SN-1',
         $4, $5, 'POOR')
       RETURNING id`,
      [`BAJ-${tag}`, `MONITOR DAÑADO ${tag}`, categoryId, costCenterId, director.userId, price],
    );
  };

  const items = (assetIds: ReadonlyArray<string>) => assetIds.map((assetId) => ({ assetId, state: 'OBSOLETE' }));

  const create = (assetIds: ReadonlyArray<string>, overrides: Record<string, unknown> = {}, who: Actor = director) =>
    http()
      .post('/api/v1/write-offs')
      .set(auth(who))
      .send({ items: items(assetIds), authorizedTotal: 1500000, ...overrides });

  const generate = (id: string, body: Record<string, unknown> = {}) =>
    http()
      .post(`/api/v1/write-offs/${id}/generate`)
      .set(auth(director))
      .send({ controlSignerPersonId: auditor.personId, accountingSignerPersonId: accountant.personId, ...body });

  const cancel = (id: string) => http().post(`/api/v1/write-offs/${id}/cancel`).set(auth(director)).send({ reason: 'Prueba terminada' });
  const detail = async (id: string, who: Actor = director) => (await http().get(`/api/v1/write-offs/${id}`).set(auth(who)).expect(200)).body.data;
  const drain = () => engine.processPending(1000);
  const sign = (documentId: string, order: number, who: Actor) =>
    http().post(`/api/v1/documents/${documentId}/signatures/${order}`).set(auth(who)).send({ rubric });
  const statusOf = (assetId: string) => scalar<string>(dataSource, 'SELECT operational_status::text FROM asset WHERE id = $1', [assetId]);

  const expectConforms = (method: string, route: string, status: number, body: unknown) => {
    const operation = (openapi.paths[route] as Record<string, { responses: Record<string, { content?: Record<string, { schema: Schema }> }> }>)[method];
    const schema = operation?.responses[String(status)]?.content?.['application/json']?.schema;
    expect(schema, `${method.toUpperCase()} ${route} ${status} no declara esquema`).toBeDefined();
    const errors: string[] = [];
    conform(openapi, body, schema ?? {}, `${method.toUpperCase()} ${route}`, errors);
    expect(errors).toEqual([]);
  };

  const generated = async (assetIds: ReadonlyArray<string>, overrides: Record<string, unknown> = {}) => {
    const created = (await create(assetIds, overrides).expect(201)).body.data;
    await generate(created.id).expect(200);
    await drain();
    const writeOff = await detail(created.id);
    expect(writeOff.document.generation).toBe('GENERATED');
    return { id: created.id as string, documentId: writeOff.document.documentId as string, number: writeOff.document.number as string };
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
    sequenceBefore = await scalar<string | undefined>(dataSource, `SELECT current_value FROM document_sequence WHERE format_key = $1 AND period = ''`, [FORMAT]);

    const tag = randomUUID().slice(0, 6).toUpperCase();
    center = await scalar<string>(dataSource, `INSERT INTO cost_center (external_code, name) VALUES ($1, 'Sistemas de Bajas') RETURNING id`, [`B1${tag}`]);
    other = await scalar<string>(dataSource, `INSERT INTO cost_center (external_code, name) VALUES ($1, 'Egresados de Bajas') RETURNING id`, [`B2${tag}`]);
    categoryId = await scalar<string>(
      dataSource,
      `INSERT INTO asset_category (code, name, requires_photo) VALUES ($1, 'Equipos de baja', FALSE) RETURNING id`,
      [`BAJ_${tag}`],
    );
    reasonId = await scalar<string>(dataSource, `SELECT id FROM asset_transfer_reason WHERE code = 'REUBICACION'`);

    director = await actor('Directora', { mfa: true, role: 'INTERNAL_CONTROL_DIRECTOR' });
    auditor = await actor('Auditora', { mfa: true, role: 'AUDITOR' });
    await grant(auditor.userId, await createPermissionRole(dataSource, ['act:sign_control:global'], 'IT_FIRMA_BAJA'));
    accountant = await actor('Contadora', { mfa: false, role: 'CONTABILIDAD' });
    keeper = await actor('Jefe', { mfa: false });
    receiver = await actor('Receptor', { mfa: false });
    outsider = await actor('Ajeno', { mfa: false });
    scopedReader = await actor('Lectora', { mfa: false, role: 'VIEWER', scopeId: other });
    await assignTestHead(dataSource, center, keeper.personId);
    await assignTestHead(dataSource, other, receiver.personId);
    rubric = `data:image/png;base64,${(await QRCode.toBuffer('rubrica', { width: 120 })).toString('base64')}`;
    const uploaded = await engine.uploadTemplate(
      FORMAT,
      { buffer: await readFile(TEMPLATE), originalname: 'OCI-17-90-BAJA-v1.docx' },
      { sgcVersion: '1', effectiveDate: '2024-08-06' },
      director.userId,
    );
    templateId = uploaded.id ?? '';
  });

  afterAll(async () => {
    const ids = ((await dataSource.query(`SELECT id FROM document WHERE entity_type = 'WRITE_OFF'`)) as Array<{ id: string }>).map((item) => item.id);
    await dataSource.query('DELETE FROM asset_write_off_item');
    await dataSource.query('DELETE FROM asset_write_off');
    await dataSource.query('DELETE FROM document_signature_reassignment WHERE document_id = ANY($1)', [ids]);
    await dataSource.query(
      'DELETE FROM signature_envelope_signer WHERE envelope_id IN (SELECT id FROM signature_envelope WHERE document_id = ANY($1))',
      [ids],
    );
    await dataSource.query('DELETE FROM signature_signing_link WHERE document_id = ANY($1)', [ids]);
    await dataSource.query('DELETE FROM signature_envelope WHERE document_id = ANY($1)', [ids]);
    await dataSource.query(`DELETE FROM document_request WHERE payload->>'entityType' = 'WRITE_OFF'`);
    await dataSource.query('DELETE FROM document_asset WHERE document_id = ANY($1)', [ids]);
    await dataSource.query('DELETE FROM document WHERE id = ANY($1)', [ids]);
    await dataSource.query('DELETE FROM document_template_version WHERE id = $1', [templateId || null]);
    await dataSource.query('DELETE FROM document_sequence WHERE format_key = $1', [FORMAT]);
    if (sequenceBefore !== undefined) {
      await dataSource.query(`INSERT INTO document_sequence (format_key, period, current_value) VALUES ($1, '', $2)`, [FORMAT, sequenceBefore]);
    }
    await dataSource.query(
      `UPDATE user_role SET revoked_at = NOW() WHERE revoked_at IS NULL AND role_id = (SELECT id FROM role WHERE code = 'CONTABILIDAD')`,
    );
    await app.close();
  });

  it('el formato vigente firma Control Interno y luego Contabilidad y deja las decisiones pendientes', async () => {
    const format = await app.get(DocumentFormatCatalogService).current(FORMAT);
    expect(format.signers.map((signer) => [signer.order, signer.role, signer.source])).toEqual([
      [1, 'CONTROL_INTERNO', 'REQUEST'],
      [2, 'CONTABILIDAD', 'REQUEST'],
    ]);
    expect(format.pendingDecisions.length).toBeGreaterThanOrEqual(5);
    for (const decision of format.pendingDecisions) {
      expect(decision).toMatch(/pendiente de validar con Control Interno$/);
    }
    const states = (await http().get('/api/v1/write-offs/item-states').set(auth(director)).expect(200)).body.data;
    expect(states).toEqual([
      { code: 'OBSOLETE', label: 'Obsoleto' },
      { code: 'DAMAGED', label: 'Dañado' },
      { code: 'STOLEN', label: 'Robado' },
      { code: 'NOT_AN_ASSET', label: 'No es activo' },
      { code: 'OTHER', label: 'Otro' },
    ]);
    const accountants = (await http().get('/api/v1/write-offs/accounting-signers').set(auth(director)).expect(200)).body.data;
    expect(accountants).toEqual([{ personId: accountant.personId, name: accountant.name }]);
  });

  it('ciclo completo con activos de dos centros: el acta lleva el centro por fila y al firmarse quedan dados de baja', async () => {
    const first = await asset(center, 1000000);
    const second = await asset(other, 250000.5);
    const created = (
      await create([first, second], {
        items: [
          { assetId: first, state: 'OBSOLETE', notes: 'Autorizado por el Consejo' },
          { assetId: second, state: 'DAMAGED', quantity: 10 },
        ],
        authorizedTotal: 1200000,
        councilAgreementNumber: 'ACUERDO 030-2026',
        councilAgreementDate: '2026-07-28',
        vicefinanceReports: 'IBV - 00015 y 00016',
        observations: 'La depreciación cambió',
      }).expect(201)
    ).body.data;
    expectConforms('post', '/api/v1/write-offs', 201, { data: created, type: 'SUCCESS', action: 'CONTINUE' });
    expect(created).toMatchObject({
      status: 'DRAFT',
      reportTotal: 1250000.5,
      authorizedTotal: 1200000,
      difference: -50000.5,
      councilAgreementNumber: 'ACUERDO 030-2026',
      councilAgreementDate: '2026-07-28',
      document: { generation: 'NONE' },
    });
    expect(created.costCenters.map((item: { id: string }) => item.id).sort()).toEqual([center, other].sort());
    expect(created.items).toEqual([
      expect.objectContaining({
        lineNumber: 1,
        quantity: 1,
        state: 'OBSOLETE',
        stateLabel: 'Obsoleto',
        notes: 'Autorizado por el Consejo',
        costCenter: expect.objectContaining({ id: center }),
        asset: expect.objectContaining({ id: first, acquisitionDocument: 'IC-740', acquisitionDate: '2019-03-10', acquisitionPrice: 1000000 }),
      }),
      expect.objectContaining({ lineNumber: 2, quantity: 10, state: 'DAMAGED', stateLabel: 'Dañado', costCenter: expect.objectContaining({ id: other }) }),
    ]);
    await detail(created.id, scopedReader);

    await generate(created.id).expect(200);
    await drain();
    const pending = await detail(created.id);
    const documentId = pending.document.documentId as string;
    const number = pending.document.number as string;
    expect(pending).toMatchObject({ status: 'PENDING_SIGNATURES', controlSigner: { id: auditor.personId }, accountingSigner: { id: accountant.personId } });
    expect(pending.document.signatures.map((item: { role: string; personId: string }) => [item.role, item.personId])).toEqual([
      ['CONTROL_INTERNO', auditor.personId],
      ['CONTABILIDAD', accountant.personId],
    ]);
    const data = await scalar<{
      campos: Record<string, string>;
      activos: Array<{ id: string; campos: Record<string, string> }>;
    }>(dataSource, 'SELECT data FROM document WHERE id = $1', [documentId]);
    expect(data.campos).toMatchObject({
      acuerdoConsejo: 'ACUERDO 030-2026',
      fechaAcuerdo: '28 DE JULIO DE 2026',
      informesVicefinanciera: 'IBV - 00015 y 00016',
      nota: 'La depreciación cambió',
    });
    expect(data.activos[0]?.campos).toMatchObject({ cantidad: '1', documento: 'IC-740', estado: 'Obsoleto', observaciones: 'Autorizado por el Consejo' });
    expect(data.activos[0]?.campos['centro']).toContain('Sistemas de Bajas');
    expect(data.activos[1]?.campos).toMatchObject({ cantidad: '10', estado: 'Dañado' });
    expect(data.activos[1]?.campos['centro']).toContain('Egresados de Bajas');

    await sign(documentId, 1, auditor).expect(200);
    expect(await statusOf(first)).not.toBe('WRITTEN_OFF');
    const cancelSigned = await cancel(created.id);
    expect([cancelSigned.status, cancelSigned.body.error.code]).toEqual([406, 'WRITE_OFF_INVALID_STATE_TRANSITION']);
    await sign(documentId, 2, accountant).expect(200);

    const done = await detail(created.id);
    expect(done).toMatchObject({ status: 'COMPLETED', document: { status: 'SIGNED', number } });
    for (const [assetId, reason] of [
      [first, 'Obsoleto. Autorizado por el Consejo'],
      [second, 'Dañado'],
    ] as const) {
      const [row] = (await dataSource.query(
        `SELECT operational_status::text AS status, written_off_at, write_off_reason, write_off_document FROM asset WHERE id = $1`,
        [assetId],
      )) as Array<{ status: string; written_off_at: string | null; write_off_reason: string; write_off_document: string }>;
      expect(row).toMatchObject({ status: 'WRITTEN_OFF', write_off_reason: reason, write_off_document: number });
      expect(row?.written_off_at).not.toBeNull();
      const movements = (await dataSource.query(
        `SELECT id, document_reference, metadata, event_signature AS signature FROM asset_movement WHERE asset_id = $1 AND movement_type = 'WRITE_OFF'`,
        [assetId],
      )) as Array<{ id: string; document_reference: string; metadata: Record<string, unknown>; signature: string | null }>;
      expect(movements).toHaveLength(1);
      expect(movements[0]).toMatchObject({ document_reference: number, metadata: expect.objectContaining({ writeOffId: created.id, documentId }) });
      expect(movements[0]?.signature).toBeTruthy();
      expect(done.items.find((item: { asset: { id: string } }) => item.asset.id === assetId).movementId).toBe(movements[0]?.id);
      expect(await scalar<string>(dataSource, 'SELECT movement_id FROM document_asset WHERE document_id = $1 AND asset_id = $2', [documentId, assetId])).toBe(
        movements[0]?.id,
      );
      const timeline = await app.get(AssetTimelineService).timeline(assetId, { page: 1, pageSize: 50, order: 'asc' }, GLOBAL_COST_CENTER_SCOPE);
      expect(timeline.items.find((entry) => entry.type === 'WRITE_OFF')).toMatchObject({
        document: { id: documentId, formatKey: FORMAT, number, status: 'SIGNED' },
      });
    }
    expectConforms('get', '/api/v1/write-offs/{id}', 200, (await http().get(`/api/v1/write-offs/${created.id}`).set(auth(director))).body);
    await engine.syncSignatures(documentId);
    expect(await scalar<number>(dataSource, `SELECT count(*)::int FROM asset_movement WHERE asset_id = $1 AND movement_type = 'WRITE_OFF'`, [first])).toBe(1);
    const again = await create([first]);
    expect([again.status, again.body.error.code]).toEqual([409, 'WRITE_OFF_ASSET_HELD']);
  });

  it('sin total autorizado no se genera el acta y Contabilidad debe tener el rol', async () => {
    const draft = (await create([await asset()], { authorizedTotal: null }).expect(201)).body.data;
    const missing = await generate(draft.id);
    expect([missing.status, missing.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);
    expect(missing.body.error.details).toEqual([{ field: 'authorizedTotal', message: 'Escriba el total autorizado.' }]);
    await http().patch(`/api/v1/write-offs/${draft.id}`).set(auth(director)).send({ authorizedTotal: 1500000 }).expect(200);
    const notAccountant = await generate(draft.id, { accountingSignerPersonId: keeper.personId });
    expect([notAccountant.status, notAccountant.body.error.code]).toEqual([400, 'WRITE_OFF_SIGNER_NOT_ELIGIBLE']);
    expect((await detail(draft.id)).status).toBe('DRAFT');
    await cancel(draft.id).expect(200);
  });

  it('un rechazo deja la baja REJECTED, no toca los activos y los libera', async () => {
    const assetId = await asset();
    const { id, documentId } = await generated([assetId]);
    await sign(documentId, 1, auditor).expect(200);
    await http().post(`/api/v1/documents/${documentId}/signatures/2/reject`).set(auth(accountant)).send({ reason: 'El total no cuadra' }).expect(200);
    expect(await detail(id)).toMatchObject({ status: 'REJECTED', document: { status: 'REJECTED' } });
    expect(await statusOf(assetId)).toBe('IN_USE');
    expect(await scalar<number>(dataSource, `SELECT count(*)::int FROM asset_movement WHERE asset_id = $1 AND movement_type = 'WRITE_OFF'`, [assetId])).toBe(0);
    await http().patch(`/api/v1/assets/${assetId}`).set(auth(director)).send({ description: 'MONITOR REVISADO' }).expect(200);
    const reuse = await create([assetId]).expect(201);
    await cancel(reuse.body.data.id).expect(200);
  });

  it('retenciones en los dos sentidos y edición solo en borrador', async () => {
    const held = await asset();
    const draft = (await create([held]).expect(201)).body.data;

    const twice = await create([held]);
    expect([twice.status, twice.body.error.code]).toEqual([409, 'WRITE_OFF_ASSET_HELD']);
    expect(twice.body.error.details[0].message).toMatch(/está en otra baja abierta\.$/);

    const transfer = await http()
      .post('/api/v1/transfers')
      .set(auth(director))
      .send({
        items: [{ assetId: held, reasonId }],
        targetCostCenterId: other,
        requesterPersonId: keeper.personId,
        ownerPersonId: receiver.personId,
        justification: 'Mover el monitor',
      });
    expect([transfer.status, transfer.body.error.code]).toEqual([409, 'ASSET_IN_OPEN_WRITE_OFF']);

    const edit = await http().patch(`/api/v1/assets/${held}`).set(auth(director)).send({ description: 'OTRO NOMBRE' });
    expect([edit.status, edit.body.error.code]).toEqual([409, 'ASSET_IN_OPEN_WRITE_OFF']);
    const direct = await http().post(`/api/v1/assets/${held}/write-off`).set(auth(director)).send({ reason: 'Daño', documentReference: 'X-1' });
    expect([direct.status, direct.body.error.code]).toEqual([409, 'ASSET_IN_OPEN_WRITE_OFF']);

    const inTransfer = await asset();
    const openTransfer = (
      await http()
        .post('/api/v1/transfers')
        .set(auth(director))
        .send({
          items: [{ assetId: inTransfer, reasonId }],
          targetCostCenterId: other,
          requesterPersonId: keeper.personId,
          ownerPersonId: receiver.personId,
          justification: 'Mover el equipo',
        })
        .expect(201)
    ).body.data;
    const blocked = await create([inTransfer]);
    expect([blocked.status, blocked.body.error.code]).toEqual([409, 'WRITE_OFF_ASSET_HELD']);
    expect(blocked.body.error.details[0].message).toMatch(/está en un traslado abierto\.$/);
    await http().post(`/api/v1/transfers/${openTransfer.id}/cancel`).set(auth(director)).send({ reason: 'Prueba terminada' }).expect(200);

    const inventoryAsset = await asset();
    const inventoryId = await scalar<string>(
      dataSource,
      `INSERT INTO physical_inventory (code, name, scheduled_start_date, scheduled_end_date, status, responsible_user_id, created_by, scope_type, scope_id)
       VALUES ($1, 'Auditoría de bajas', '2026-01-01', '2026-01-31', 'IN_PROGRESS', $2, $2, 'COST_CENTER', $3) RETURNING id`,
      [`TF-BAJ-${randomUUID().slice(0, 6)}`, director.userId, center],
    );
    await dataSource.query('INSERT INTO physical_inventory_item (inventory_id, asset_id, expected_cost_center_id) VALUES ($1, $2, $3)', [
      inventoryId,
      inventoryAsset,
      center,
    ]);
    const audited = await create([inventoryAsset]);
    expect([audited.status, audited.body.error.code]).toEqual([409, 'WRITE_OFF_ASSET_HELD']);
    expect(audited.body.error.details[0].message).toMatch(/está en una toma física abierta\.$/);
    await dataSource.query('DELETE FROM physical_inventory_item WHERE inventory_id = $1', [inventoryId]);
    await dataSource.query('DELETE FROM physical_inventory WHERE id = $1', [inventoryId]);

    const badState = await create([await asset()], { items: [{ assetId: await asset(), state: 'LOST' }] });
    expect([badState.status, badState.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);

    const extra = await asset(other);
    const edited = await http()
      .patch(`/api/v1/write-offs/${draft.id}`)
      .set(auth(director))
      .send({
        items: [
          { assetId: held, state: 'STOLEN', notes: 'Denuncia 123' },
          { assetId: extra, state: 'NOT_AN_ASSET' },
        ],
        vicefinanceReports: 'IBV - 00020',
      })
      .expect(200);
    expect(edited.body.data.vicefinanceReports).toBe('IBV - 00020');
    expect(edited.body.data.items.map((item: { asset: { id: string }; state: string }) => [item.asset.id, item.state])).toEqual([
      [held, 'STOLEN'],
      [extra, 'NOT_AN_ASSET'],
    ]);
    await generate(draft.id).expect(200);
    const late = await http().patch(`/api/v1/write-offs/${draft.id}`).set(auth(director)).send({ authorizedTotal: 1 });
    expect([late.status, late.body.error.code]).toEqual([406, 'WRITE_OFF_INVALID_STATE_TRANSITION']);
    await drain();
    const documentId = (await detail(draft.id)).document.documentId as string;
    await cancel(draft.id).expect(200);
    expect(await detail(draft.id)).toMatchObject({ status: 'CANCELLED', cancelReason: 'Prueba terminada' });
    expect(await scalar<string>(dataSource, 'SELECT status FROM document WHERE id = $1', [documentId])).toBe('VOIDED');
    await http().patch(`/api/v1/assets/${held}`).set(auth(director)).send({ description: 'MONITOR LIBRE' }).expect(200);

    const denied = await create([await asset()], {}, outsider);
    expect(denied.status).toBe(403);
    await http().get(`/api/v1/write-offs/${draft.id}`).set(auth(outsider)).expect(403);
    const onlyCenter = (await create([await asset()]).expect(201)).body.data;
    await http().get(`/api/v1/write-offs/${onlyCenter.id}`).set(auth(scopedReader)).expect(404);
    const scopedList = (await http().get('/api/v1/write-offs?pageSize=100').set(auth(scopedReader)).expect(200)).body.data.items.map(
      (item: { id: string }) => item.id,
    );
    expect(scopedList).toContain(draft.id);
    expect(scopedList).not.toContain(onlyCenter.id);
    await cancel(onlyCenter.id).expect(200);
    const list = (await http().get('/api/v1/write-offs?pageSize=100').set(auth(director)).expect(200)).body;
    expectConforms('get', '/api/v1/write-offs', 200, list);
    expect(list.data.items.map((item: { id: string }) => item.id)).toContain(draft.id);
  });
});
