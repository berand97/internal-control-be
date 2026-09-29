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
import { GLOBAL_COST_CENTER_SCOPE } from '../../src/modules/roles/services/cost-center-scope.js';
import { conform, type Schema } from './openapi-conform.js';
import { createPermissionRole, scalar, useSharedStorage } from './helpers.js';
import { DocxTextPdfConverter } from './pdf-text.js';

const FORMAT = 'OCI-17-89';
const TEMPLATE = 'templates/formats/OCI-17-89-v1.docx';

interface Actor {
  userId: string;
  personId: string;
  token: string;
  name: string;
}

describe('Traslado de activos OCI-17-89 (HTTP real + PostgreSQL real)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let engine: DocumentEngineService;
  let openapi: OpenAPIObject;
  let director: Actor;
  let auditor: Actor;
  let accountant: Actor;
  let secondAccountant: Actor;
  let deliverer: Actor;
  let receiver: Actor;
  let outsider: Actor;
  let scopedReader: Actor;
  let rubric: string;
  let source = '';
  let target = '';
  let other = '';
  let categoryId = '';
  let reasonId = '';
  let templateId = '';
  let sequenceBefore: string | undefined;

  const http = () => request(app.getHttpServer());
  const auth = (who: Actor) => ({ Authorization: `Bearer ${who.token}` });

  const actor = async (first: string, options: { mfa: boolean; role?: string; scopeId?: string }): Promise<Actor> => {
    const tag = randomUUID().slice(0, 8);
    const personId = await scalar<string>(
      dataSource,
      `INSERT INTO person (first_name, last_name, email, document_type, document_number, position_title)
       VALUES ($1, 'Traslado', $2, 'CC', $3, 'Funcionario de prueba') RETURNING id`,
      [first, `traslado.${tag}@unac.edu.co`, `7${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 1000)}`],
    );
    const userId = await scalar<string>(
      dataSource,
      `INSERT INTO app_user (person_id, username, password_hash, mfa_enabled, status) VALUES ($1, $2, 'x', $3, 'ACTIVE') RETURNING id`,
      [personId, `traslado.${tag}`, options.mfa],
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
      username: `traslado.${tag}`,
      roles: [],
      scopes: [],
      mustChangePassword: false,
      sessionId,
    });
    return { userId, personId, token, name: `${first} Traslado` };
  };

  const grant = (userId: string, role: string, scopeId?: string) =>
    dataSource.query(
      `INSERT INTO user_role (user_id, role_id, scope_type, scope_id)
       SELECT $1, id, CASE WHEN $3::uuid IS NULL THEN 'GLOBAL' ELSE 'COST_CENTER' END, $3 FROM role WHERE code = $2`,
      [userId, role, scopeId ?? null],
    );

  const revoke = (userId: string, role: string) =>
    dataSource.query(
      `UPDATE user_role SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL AND role_id = (SELECT id FROM role WHERE code = $2)`,
      [userId, role],
    );

  const asset = async (costCenterId = source) => {
    const tag = randomUUID().slice(0, 8).toUpperCase();
    return scalar<string>(
      dataSource,
      `INSERT INTO asset (internal_code, description, category_id, acquisition_type_id, acquisition_date, acquisition_document,
         acquisition_price, model, serial_number, current_cost_center_id, created_by, physical_condition)
       VALUES ($1, $2, $3, (SELECT id FROM acquisition_type WHERE code = 'PURCHASE'), '2022-11-30', 'FV-7788', 213000, 'CO-1', 'SN-1',
         $4, $5, 'GOOD')
       RETURNING id`,
      [`TRA-${tag}`, `SILLA ERGONOMICA ${tag}`, categoryId, costCenterId, director.userId],
    );
  };

  const create = (assetIds: ReadonlyArray<string>, overrides: Record<string, unknown> = {}, who: Actor = director) =>
    http()
      .post('/api/v1/transfers')
      .set(auth(who))
      .send({
        items: assetIds.map((assetId, index) => ({
          assetId,
          reasonId,
          physicallyVerified: true,
          numberingPresent: index === 0,
          observations: index === 0 ? 'Con cojín' : undefined,
        })),
        targetCostCenterId: target,
        requesterPersonId: deliverer.personId,
        ownerPersonId: receiver.personId,
        justification: 'Reorganización del área',
        ...overrides,
      });

  const generate = (id: string, body: Record<string, unknown> = {}) =>
    http()
      .post(`/api/v1/transfers/${id}/generate`)
      .set(auth(director))
      .send({ controlSignerPersonId: auditor.personId, accountingSignerPersonId: accountant.personId, ...body });

  const detail = async (id: string, who: Actor = director) => (await http().get(`/api/v1/transfers/${id}`).set(auth(who)).expect(200)).body.data;
  const drain = () => engine.processPending(1000);
  const sign = (documentId: string, order: number, who: Actor) =>
    http().post(`/api/v1/documents/${documentId}/signatures/${order}`).set(auth(who)).send({ rubric });
  const centerOf = (assetId: string) => scalar<string>(dataSource, 'SELECT current_cost_center_id FROM asset WHERE id = $1', [assetId]);

  const expectConforms = (method: string, route: string, status: number, body: unknown) => {
    const operation = (openapi.paths[route] as Record<string, { responses: Record<string, { content?: Record<string, { schema: Schema }> }> }>)[method];
    const schema = operation?.responses[String(status)]?.content?.['application/json']?.schema;
    expect(schema, `${method.toUpperCase()} ${route} ${status} no declara esquema`).toBeDefined();
    const errors: string[] = [];
    conform(openapi, body, schema ?? {}, `${method.toUpperCase()} ${route}`, errors);
    expect(errors).toEqual([]);
  };

  /** Crea, genera y devuelve el traslado con su acta generada. */
  const generated = async (assetIds: ReadonlyArray<string>, body: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) => {
    const created = (await create(assetIds, overrides).expect(201)).body.data;
    await generate(created.id, body).expect(200);
    await drain();
    const transfer = await detail(created.id);
    expect(transfer.document.generation).toBe('GENERATED');
    return { id: created.id as string, documentId: transfer.document.documentId as string, number: transfer.document.number as string };
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
    source = await scalar<string>(dataSource, `INSERT INTO cost_center (external_code, name) VALUES ($1, 'Tesorería de Traslados') RETURNING id`, [`T1${tag}`]);
    target = await scalar<string>(dataSource, `INSERT INTO cost_center (external_code, name) VALUES ($1, 'Compras de Traslados') RETURNING id`, [`T2${tag}`]);
    other = await scalar<string>(dataSource, `INSERT INTO cost_center (external_code, name) VALUES ($1, 'Otro centro de Traslados') RETURNING id`, [`T3${tag}`]);
    categoryId = await scalar<string>(
      dataSource,
      `INSERT INTO asset_category (code, name, requires_photo) VALUES ($1, 'Muebles de traslado', FALSE) RETURNING id`,
      [`TRA_${tag}`],
    );
    reasonId = await scalar<string>(dataSource, `SELECT id FROM asset_transfer_reason WHERE code = 'REUBICACION'`);

    director = await actor('Directora', { mfa: true, role: 'INTERNAL_CONTROL_DIRECTOR' });
    // Firma por Control Interno por tener act:sign_control:global en un rol cualquiera, no por llamarse AUDITOR.
    auditor = await actor('Auditora', { mfa: true, role: 'AUDITOR' });
    await grant(auditor.userId, await createPermissionRole(dataSource, ['act:sign_control:global'], 'IT_FIRMA_CONTROL'));
    accountant = await actor('Contadora', { mfa: false });
    secondAccountant = await actor('Contador', { mfa: false });
    deliverer = await actor('Entregador', { mfa: false });
    receiver = await actor('Receptora', { mfa: false });
    outsider = await actor('Ajeno', { mfa: false });
    scopedReader = await actor('Lectora', { mfa: false, role: 'VIEWER', scopeId: target });
    rubric = `data:image/png;base64,${(await QRCode.toBuffer('rubrica', { width: 120 })).toString('base64')}`;
    // Plantilla vigente del formato (solo en tests: en producción la carga Control Interno).
    const uploaded = await engine.uploadTemplate(
      FORMAT,
      { buffer: await readFile(TEMPLATE), originalname: 'OCI-17-89-v1.docx' },
      { sgcVersion: '1', effectiveDate: '2024-08-06' },
      director.userId,
    );
    templateId = uploaded.id ?? '';
  });

  afterAll(async () => {
    const ids = ((await dataSource.query(`SELECT id FROM document WHERE entity_type = 'TRANSFER'`)) as Array<{ id: string }>).map((item) => item.id);
    await dataSource.query('DELETE FROM asset_transfer_item');
    await dataSource.query('DELETE FROM asset_transfer');
    await dataSource.query('DELETE FROM document_signature_reassignment WHERE document_id = ANY($1)', [ids]);
    await dataSource.query(
      'DELETE FROM signature_envelope_signer WHERE envelope_id IN (SELECT id FROM signature_envelope WHERE document_id = ANY($1))',
      [ids],
    );
    await dataSource.query('DELETE FROM signature_signing_link WHERE document_id = ANY($1)', [ids]);
    await dataSource.query('DELETE FROM signature_envelope WHERE document_id = ANY($1)', [ids]);
    await dataSource.query(`DELETE FROM document_request WHERE payload->>'entityType' = 'TRANSFER'`);
    await dataSource.query('DELETE FROM document_asset WHERE document_id = ANY($1)', [ids]);
    await dataSource.query('DELETE FROM document WHERE id = ANY($1)', [ids]);
    await dataSource.query('DELETE FROM document_template_version WHERE id = $1', [templateId || null]);
    await dataSource.query('DELETE FROM document_sequence WHERE format_key = $1', [FORMAT]);
    if (sequenceBefore !== undefined) {
      await dataSource.query(`INSERT INTO document_sequence (format_key, period, current_value) VALUES ($1, '', $2)`, [FORMAT, sequenceBefore]);
    }
    await dataSource.query(`UPDATE user_role SET revoked_at = NOW() WHERE revoked_at IS NULL AND role_id = (SELECT id FROM role WHERE code = 'CONTABILIDAD')`);
    await app.close();
  });

  it('Contabilidad: ninguno → aviso y TRANSFER_NO_ACCOUNTING_SIGNER al generar; uno → se toma solo; varios → hay que elegir', async () => {
    const assetId = await asset();
    const created = (await create([assetId]).expect(201)).body.data;
    expectConforms('post', '/api/v1/transfers', 201, { data: created, type: 'SUCCESS', action: 'CONTINUE' });
    expect(created).toMatchObject({
      status: 'DRAFT',
      accountingSignerAvailable: false,
      controlSignerAvailable: true,
      warnings: [expect.objectContaining({ code: 'NO_ACCOUNTING_SIGNER' })],
      document: { generation: 'NONE', requestId: null, documentId: null },
    });
    expect((await http().get('/api/v1/transfers/accounting-signers').set(auth(director)).expect(200)).body.data).toEqual([]);
    const none = await http().post(`/api/v1/transfers/${created.id}/generate`).set(auth(director)).send({ controlSignerPersonId: auditor.personId });
    expect([none.status, none.body.error.code]).toEqual([409, 'TRANSFER_NO_ACCOUNTING_SIGNER']);
    expect(none.body.error.message).toContain('Pídele al administrador');
    expect((await detail(created.id)).status).toBe('DRAFT');

    // Uno: el rol CONTABILIDAD (sembrado sin usuarios) lo da transfer:sign_accounting:global.
    await grant(accountant.userId, 'CONTABILIDAD');
    expect((await http().get('/api/v1/transfers/accounting-signers').set(auth(director)).expect(200)).body.data).toEqual([
      { personId: accountant.personId, name: accountant.name },
    ]);
    // Varios: hay que decir cuál, y debe ser uno de ellos.
    await grant(secondAccountant.userId, 'CONTABILIDAD');
    const many = await http().post(`/api/v1/transfers/${created.id}/generate`).set(auth(director)).send({ controlSignerPersonId: auditor.personId });
    expect([many.status, many.body.error.code]).toEqual([400, 'TRANSFER_SIGNER_REQUIRED']);
    const notEligible = await generate(created.id, { accountingSignerPersonId: deliverer.personId });
    expect([notEligible.status, notEligible.body.error.code]).toEqual([400, 'TRANSFER_SIGNER_NOT_ELIGIBLE']);
    await revoke(secondAccountant.userId, 'CONTABILIDAD');
    const single = await http().post(`/api/v1/transfers/${created.id}/generate`).set(auth(director)).send({ controlSignerPersonId: auditor.personId });
    expect(single.status).toBe(200);
    expect(single.body.data).toMatchObject({
      status: 'PENDING_SIGNATURES',
      accountingSigner: { id: accountant.personId },
      controlSigner: { id: auditor.personId },
      accountingSignerAvailable: true,
      warnings: [],
      document: { generation: 'PENDING' },
    });
    // Control Interno: lo decide act:sign_control:global vigente, no el nombre del rol.
    const plainAuditor = await actor('Auditor', { mfa: true, role: 'AUDITOR' });
    const controlSigners = (await http().get('/api/v1/transfers/control-signers').set(auth(director)).expect(200)).body.data as Array<{
      personId: string;
    }>;
    expect(controlSigners.map((item) => item.personId)).toEqual(expect.arrayContaining([director.personId, auditor.personId]));
    expect(controlSigners.map((item) => item.personId)).not.toContain(plainAuditor.personId);
    const other = (await create([await asset()]).expect(201)).body.data;
    for (const ineligible of [deliverer, plainAuditor]) {
      const badControl = await generate(other.id, { controlSignerPersonId: ineligible.personId });
      expect([badControl.status, badControl.body.error.code]).toEqual([400, 'TRANSFER_SIGNER_NOT_ELIGIBLE']);
      expect(badControl.body.error.message).toContain('Firmar actas por Control Interno');
    }
    await revoke(plainAuditor.userId, 'AUDITOR');
    await http().post(`/api/v1/transfers/${other.id}/cancel`).set(auth(director)).send({ reason: 'Prueba terminada' }).expect(200);
    await http().post(`/api/v1/transfers/${created.id}/cancel`).set(auth(director)).send({ reason: 'Prueba terminada' }).expect(200);
  });

  it('flujo completo: crear → generar → cuatro firmas → COMPLETED con el centro cambiado y el TRANSFER enlazado al acta', async () => {
    const first = await asset();
    const second = await asset();
    const { id, documentId, number } = await generated([first, second]);
    expect(number).toMatch(/^\d{5}$/);
    const pending = await detail(id);
    expect(pending.document.signatures.map((signature: { role: string; personId: string }) => [signature.role, signature.personId])).toEqual([
      ['ENTREGA', deliverer.personId],
      ['RECIBE', receiver.personId],
      ['CONTROL_INTERNO', auditor.personId],
      ['CONTABILIDAD', accountant.personId],
    ]);
    const data = await scalar<{
      campos: Record<string, string>;
      activos: Array<{ id: string; campos: Record<string, string> }>;
      centroCosto: { nombre: string };
    }>(dataSource, 'SELECT data FROM document WHERE id = $1', [documentId]);
    expect(data.centroCosto.nombre).toBe('Tesorería de Traslados');
    expect(data.campos).toMatchObject({ centroDestinoNombre: 'Compras de Traslados', justificacion: 'Reorganización del área' });
    expect(data.activos[0]?.campos).toMatchObject({ fisico: 'Sí', numeracion: 'Sí', motivo: 'Reubicación', estado: 'Bueno', observaciones: 'Con cojín' });
    expect(data.activos[1]?.campos).toMatchObject({ numeracion: 'No', modelo: 'CO-1', serie: 'SN-1', numeroDocumento: 'FV-7788' });

    // Nada se mueve antes de la última firma.
    await sign(documentId, 1, deliverer).expect(200);
    await sign(documentId, 2, receiver).expect(200);
    await sign(documentId, 3, auditor).expect(200);
    expect(await centerOf(first)).toBe(source);
    const cancelSigned = await http().post(`/api/v1/transfers/${id}/cancel`).set(auth(director)).send({ reason: 'Ya no se traslada' });
    expect([cancelSigned.status, cancelSigned.body.error.code]).toEqual([406, 'TRANSFER_INVALID_STATE_TRANSITION']);
    await sign(documentId, 4, accountant).expect(200);

    const done = await detail(id);
    expect(done).toMatchObject({ status: 'COMPLETED', document: { status: 'SIGNED', number } });
    expect(done.completedAt).not.toBeNull();
    for (const assetId of [first, second]) {
      expect(await centerOf(assetId)).toBe(target);
      const movements = (await dataSource.query(
        `SELECT id, document_reference, metadata FROM asset_movement WHERE asset_id = $1 AND movement_type = 'TRANSFER'`,
        [assetId],
      )) as Array<{ id: string; document_reference: string; metadata: Record<string, unknown> }>;
      expect(movements).toHaveLength(1);
      expect(movements[0]).toMatchObject({ document_reference: number, metadata: expect.objectContaining({ transferId: id, documentId }) });
      const item = done.items.find((entry: { asset: { id: string } }) => entry.asset.id === assetId);
      expect(item.movementId).toBe(movements[0]?.id);
      expect(await scalar<string>(dataSource, 'SELECT movement_id FROM document_asset WHERE document_id = $1 AND asset_id = $2', [documentId, assetId])).toBe(
        movements[0]?.id,
      );
      // La línea de tiempo del activo muestra el traslado con su acta.
      const timeline = await app.get(AssetTimelineService).timeline(assetId, { page: 1, pageSize: 50, order: 'asc' }, GLOBAL_COST_CENTER_SCOPE);
      expect(timeline.items.find((entry) => entry.type === 'TRANSFER')).toMatchObject({
        documentId,
        document: { id: documentId, formatKey: FORMAT, number, status: 'SIGNED' },
      });
    }
    expectConforms('get', '/api/v1/transfers/{id}', 200, (await http().get(`/api/v1/transfers/${id}`).set(auth(director))).body);
    // Reintento del ciclo de vida sobre el traslado cerrado: no mueve nada otra vez.
    await engine.syncSignatures(documentId);
    expect(
      await scalar<number>(dataSource, `SELECT count(*)::int FROM asset_movement WHERE asset_id = $1 AND movement_type = 'TRANSFER'`, [first]),
    ).toBe(1);
    // Libre de nuevo: puede entrar en otro traslado (ahora desde el destino).
    const back = await create([first], { targetCostCenterId: source }).expect(201);
    await http().post(`/api/v1/transfers/${back.body.data.id}/cancel`).set(auth(director)).send({ reason: 'Prueba terminada' }).expect(200);
  });

  it('un rechazo deja el traslado REJECTED sin mover activos y los libera', async () => {
    const assetId = await asset();
    const { id, documentId } = await generated([assetId]);
    await sign(documentId, 1, deliverer).expect(200);
    await http().post(`/api/v1/documents/${documentId}/signatures/2/reject`).set(auth(receiver)).send({ reason: 'No es el equipo acordado' }).expect(200);
    expect(await detail(id)).toMatchObject({ status: 'REJECTED', document: { status: 'REJECTED' } });
    expect(await centerOf(assetId)).toBe(source);
    const again = await create([assetId]).expect(201);
    await http().post(`/api/v1/transfers/${again.body.data.id}/cancel`).set(auth(director)).send({ reason: 'Prueba terminada' }).expect(200);
  });

  it('guardas: mismo centro, origen mezclado, préstamo abierto, otro traslado abierto, edición solo en DRAFT, cancelar anula el acta', async () => {
    const assetId = await asset();
    const same = await create([assetId], { targetCostCenterId: source });
    expect([same.status, same.body.error.code]).toEqual([400, 'TRANSFER_SAME_COST_CENTER']);
    const mixed = await create([assetId, await asset(other)]);
    expect([mixed.status, mixed.body.error.code]).toEqual([400, 'TRANSFER_MIXED_SOURCE_COST_CENTER']);

    const loaned = await asset();
    const loanId = await scalar<string>(
      dataSource,
      `INSERT INTO asset_loan (source_cost_center_id, target_cost_center_id, expected_return_date, requested_by, status, purpose, delivered_at)
       VALUES ($1, $2, CURRENT_DATE + 30, $3, 'PENDING_SIGNATURES', 'Guardas', NOW()) RETURNING id`,
      [source, other, director.userId],
    );
    await dataSource.query('INSERT INTO asset_loan_item (loan_id, asset_id, source_cost_center_id) VALUES ($1, $2, $3)', [loanId, loaned, source]);
    const onLoan = await create([loaned]);
    expect([onLoan.status, onLoan.body.error.code]).toEqual([406, 'ASSET_HAS_ACTIVE_LOAN']);

    const draft = (await create([assetId]).expect(201)).body.data;
    const twice = await create([assetId]);
    expect([twice.status, twice.body.error.code]).toEqual([409, 'TRANSFER_ASSET_IN_OPEN_TRANSFER']);

    const extra = await asset();
    const edited = await http()
      .put(`/api/v1/transfers/${draft.id}/items`)
      .set(auth(director))
      .send({ items: [{ assetId, reasonId }, { assetId: extra, reasonId, physicalCondition: 'FAIR' }] })
      .expect(200);
    expect(edited.body.data.items.map((item: { asset: { id: string }; physicalCondition: string }) => [item.asset.id, item.physicalCondition])).toEqual([
      [assetId, 'GOOD'],
      [extra, 'FAIR'],
    ]);
    await generate(draft.id).expect(200);
    const late = await http().put(`/api/v1/transfers/${draft.id}/items`).set(auth(director)).send({ items: [{ assetId, reasonId }] });
    expect([late.status, late.body.error.code]).toEqual([406, 'TRANSFER_INVALID_STATE_TRANSITION']);
    await drain();
    const documentId = (await detail(draft.id)).document.documentId as string;
    await http().post(`/api/v1/transfers/${draft.id}/cancel`).set(auth(director)).send({ reason: 'Se desiste del traslado' }).expect(200);
    expect(await detail(draft.id)).toMatchObject({ status: 'CANCELLED', cancelReason: 'Se desiste del traslado', cancelledBy: { userId: director.userId } });
    expect(await scalar<string>(dataSource, 'SELECT status FROM document WHERE id = $1', [documentId])).toBe('VOIDED');
    const reuse = await create([assetId]).expect(201);
    await http().post(`/api/v1/transfers/${reuse.body.data.id}/cancel`).set(auth(director)).send({ reason: 'Prueba terminada' }).expect(200);
    const denied = await create([assetId], {}, outsider);
    expect(denied.status).toBe(403);
  });

  it('separación de funciones: quien recibe no firma por Control Interno salvo sustituto con el permiso vigente, y queda impreso en el acta', async () => {
    const assetId = await asset();
    const created = (await create([assetId], { ownerPersonId: auditor.personId }).expect(201)).body.data;
    const duplicated = await generate(created.id);
    expect([duplicated.status, duplicated.body.error.code]).toEqual([409, 'DOCUMENT_SIGNER_DUPLICATED']);
    expect(duplicated.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'signerSubstitutions.CONTROL_INTERNO' })]),
    );
    expect((await detail(created.id)).status).toBe('DRAFT');
    const noRole = await generate(created.id, { signerSubstitutions: { CONTROL_INTERNO: { personId: deliverer.personId, reason: 'Otra persona' } } });
    expect([noRole.status, noRole.body.error.code]).toEqual([400, 'DOCUMENT_SIGNER_SUBSTITUTE_INVALID']);
    const noRoleOutsider = await generate(created.id, { signerSubstitutions: { CONTROL_INTERNO: { personId: outsider.personId, reason: 'Otra persona' } } });
    expect([noRoleOutsider.status, noRoleOutsider.body.error.code]).toEqual([400, 'DOCUMENT_SIGNER_SUBSTITUTE_INVALID']);

    await generate(created.id, {
      signerSubstitutions: { CONTROL_INTERNO: { personId: director.personId, reason: 'La auditora recibe los activos' } },
    }).expect(200);
    await drain();
    const transfer = await detail(created.id);
    const documentId = transfer.document.documentId as string;
    expect(transfer.document.signatures.find((signature: { role: string }) => signature.role === 'CONTROL_INTERNO')).toMatchObject({
      personId: director.personId,
    });
    const data = await scalar<{
      firmante: Record<string, { nombre: string; sustitucion?: { nombre: string; rol: string; motivo: string } }>;
      firmantes: Array<{ rol: string; sustituye?: { nombre: string; rol: string }; motivoSustitucion?: string }>;
      tablas: { sustituciones: Array<Record<string, string>> };
    }>(dataSource, 'SELECT data FROM document WHERE id = $1', [documentId]);
    expect(data.firmante['control_interno']).toMatchObject({
      nombre: director.name,
      sustitucion: { nombre: auditor.name, rol: 'Control Interno', motivo: 'La auditora recibe los activos' },
    });
    expect(data.firmantes.find((item) => item.rol === 'CONTROL_INTERNO')).toMatchObject({
      sustituye: { nombre: auditor.name, rol: 'Control Interno' },
      motivoSustitucion: 'La auditora recibe los activos',
    });
    expect(data.tablas.sustituciones).toEqual([
      { rol: 'Control Interno', sustituto: director.name, sustituido: auditor.name, conflicto: 'Recibe', motivo: 'La auditora recibe los activos' },
    ]);
    const reassignments = (await http().get(`/api/v1/documents/${documentId}`).set(auth(director)).expect(200)).body.data.reassignments;
    expect(reassignments).toEqual([
      expect.objectContaining({ source: 'AT_ISSUE', fromPersonId: auditor.personId, toPersonId: director.personId, previousPdfSha256: null }),
    ]);
    // La reasignación posterior tampoco puede dejar a una persona en dos firmas.
    const reassigned = await http()
      .post(`/api/v1/documents/${documentId}/signatures/1/reassign`)
      .set(auth(director))
      .send({ personId: accountant.personId, reason: 'El entregador está de viaje' });
    expect([reassigned.status, reassigned.body.error.code]).toEqual([409, 'DOCUMENT_SIGNER_DUPLICATED']);
    await http().post(`/api/v1/transfers/${created.id}/cancel`).set(auth(director)).send({ reason: 'Prueba terminada' }).expect(200);
  });

  it('alcance de lectura: global, acotado al origen o destino, Contabilidad (transfer:read:global) y sin permiso', async () => {
    const created = (await create([await asset()]).expect(201)).body.data;
    const list = (await http().get('/api/v1/transfers?pageSize=100').set(auth(director)).expect(200)).body;
    expectConforms('get', '/api/v1/transfers', 200, list);
    expect(list.data.items.map((item: { id: string }) => item.id)).toContain(created.id);
    // Lectora acotada al centro de destino: lo ve; uno entre otros centros no.
    await detail(created.id, scopedReader);
    const foreign = (await http()
      .post('/api/v1/transfers')
      .set(auth(director))
      .send({
        items: [{ assetId: await asset(other), reasonId }],
        targetCostCenterId: source,
        requesterPersonId: deliverer.personId,
        ownerPersonId: receiver.personId,
        justification: 'Otro traslado',
      })
      .expect(201)).body.data;
    await http().get(`/api/v1/transfers/${foreign.id}`).set(auth(scopedReader)).expect(404);
    const scopedList = (await http().get('/api/v1/transfers?pageSize=100').set(auth(scopedReader)).expect(200)).body.data.items.map(
      (item: { id: string }) => item.id,
    );
    expect(scopedList).toContain(created.id);
    expect(scopedList).not.toContain(foreign.id);
    // Contabilidad lee todos sin permisos de activos.
    await detail(foreign.id, accountant);
    await http().get(`/api/v1/transfers/${created.id}`).set(auth(outsider)).expect(403);
    for (const id of [created.id, foreign.id]) {
      await http().post(`/api/v1/transfers/${id}/cancel`).set(auth(director)).send({ reason: 'Prueba terminada' }).expect(200);
    }
  });

  it('catálogo de motivos: sembrado con el del Excel; la directora lo administra; uno usado no se borra', async () => {
    const reasons = (await http().get('/api/v1/transfers/reasons').set(auth(director)).expect(200)).body.data;
    expect(reasons).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'REUBICACION', name: 'Reubicación', isActive: true })]));
    const created = (await http().post('/api/v1/transfers/reasons').set(auth(director)).send({ code: 'IT_PRUEBA', name: 'Motivo de prueba' }).expect(201)).body.data;
    const duplicate = await http().post('/api/v1/transfers/reasons').set(auth(director)).send({ code: 'IT_PRUEBA', name: 'Otro' });
    expect([duplicate.status, duplicate.body.error.code]).toEqual([409, 'TRANSFER_REASON_EXISTS']);
    await http().post('/api/v1/transfers/reasons').set(auth(auditor)).send({ code: 'IT_NO', name: 'No' }).expect(403);
    const inUse = await http().delete(`/api/v1/transfers/reasons/${reasonId}`).set(auth(director));
    expect([inUse.status, inUse.body.error.code]).toEqual([409, 'TRANSFER_REASON_IN_USE']);
    await http().patch(`/api/v1/transfers/reasons/${created.id}`).set(auth(director)).send({ isActive: false }).expect(200);
    const inactive = await create([await asset()], { items: [{ assetId: await asset(), reasonId: created.id }] });
    expect([inactive.status, inactive.body.error.code]).toEqual([400, 'TRANSFER_REASON_UNAVAILABLE']);
    await http().delete(`/api/v1/transfers/reasons/${created.id}`).set(auth(director)).expect(200);
  });
});
