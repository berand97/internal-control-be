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
import { TokenService } from '../../src/modules/auth/services/token.service.js';
import { PDF_CONVERTER, type PdfConverter } from '../../src/modules/documents/pdf/pdf-converter.js';
import { DocumentEngineService } from '../../src/modules/documents/services/document-engine.service.js';
import { scalar, useSharedStorage } from './helpers.js';
import { DocxTextPdfConverter } from './pdf-text.js';

const FORMAT = 'OCI-01-55';
const TEMPLATE = 'templates/formats/OCI-01-55-v2.docx';

/** PDF real (texto del DOCX) para que el proveedor interno estampe firmas; puede fallar a pedido. */
class SwitchablePdfConverter implements PdfConverter {
  failing = false;
  private readonly inner = new DocxTextPdfConverter();

  toPdf(docx: Buffer): Promise<Buffer> {
    return this.failing ? Promise.reject(new Error('conversión simulada caída')) : this.inner.toPdf(docx);
  }
}

interface Schema {
  readonly $ref?: string;
  readonly allOf?: ReadonlyArray<Schema>;
  readonly type?: string;
  readonly nullable?: boolean;
  readonly enum?: ReadonlyArray<unknown>;
  readonly properties?: Record<string, Schema>;
  readonly required?: ReadonlyArray<string>;
  readonly items?: Schema;
}

/** Misma comparación que document-openapi.int-spec.ts: la respuesta real contra el esquema publicado. */
const conform = (openapi: OpenAPIObject, value: unknown, schema: Schema, path: string, errors: string[]): void => {
  const components = (openapi.components?.schemas ?? {}) as Record<string, Schema>;
  const resolve = (item: Schema): Schema => {
    if (item.$ref) {
      return resolve(components[item.$ref.replace('#/components/schemas/', '')] ?? {});
    }
    const { allOf, ...own } = item;
    if (allOf) {
      return [...allOf.map(resolve), own].reduce<Schema>(
        (merged, part) => ({
          ...merged,
          ...part,
          properties: { ...merged.properties, ...part.properties },
          required: [...(merged.required ?? []), ...(part.required ?? [])],
          nullable: Boolean(merged.nullable || part.nullable),
        }),
        {},
      );
    }
    return item;
  };
  const resolved = resolve(schema);
  if (value === null) {
    if (!resolved.nullable) {
      errors.push(`${path}: es null y el esquema no lo declara nullable`);
    }
    return;
  }
  if (resolved.enum && !resolved.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} no está en el enum ${JSON.stringify(resolved.enum)}`);
  }
  const type = resolved.type ?? (resolved.properties ? 'object' : undefined);
  if (type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${path}: se esperaba arreglo`);
      return;
    }
    value.forEach((item, index) => conform(openapi, item, resolved.items ?? {}, `${path}[${index}]`, errors));
    return;
  }
  if (type === 'object') {
    if (typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${path}: se esperaba objeto`);
      return;
    }
    const declared = resolved.properties ?? {};
    for (const key of Object.keys(value)) {
      if (!(key in declared)) {
        errors.push(`${path}.${key}: la respuesta la trae y el esquema no la declara`);
      }
    }
    for (const key of resolved.required ?? []) {
      if (!(key in value)) {
        errors.push(`${path}.${key}: requerida en el esquema y ausente en la respuesta`);
      }
    }
    for (const [key, property] of Object.entries(declared)) {
      if (key in value) {
        conform(openapi, (value as Record<string, unknown>)[key], property, `${path}.${key}`, errors);
      }
    }
    return;
  }
  const checks: Record<string, (item: unknown) => boolean> = {
    string: (item) => typeof item === 'string',
    integer: (item) => Number.isInteger(item),
    number: (item) => typeof item === 'number',
    boolean: (item) => typeof item === 'boolean',
  };
  if (type && checks[type] && !checks[type](value)) {
    errors.push(`${path}: se esperaba ${type} y llegó ${typeof value}`);
  }
  if (!type && !resolved.enum) {
    errors.push(`${path}: el esquema no declara tipo (queda como Object en el cliente generado)`);
  }
};

interface Actor {
  userId: string;
  personId: string;
  token: string;
  name: string;
}

describe('Acta de entrega y asignación OCI-01-55: la entrega da responsable a los activos al firmarse (HTTP real + PostgreSQL real)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let engine: DocumentEngineService;
  let converter: SwitchablePdfConverter;
  let openapi: OpenAPIObject;
  let director: Actor;
  let receiver: Actor;
  let auditor: Actor;
  let replacement: Actor;
  let outsider: Actor;
  let rubric: string;
  let costCenter = '';
  let otherCostCenter = '';
  let categoryId = '';
  let templateId = '';
  let sequenceBefore: string | undefined;

  const http = () => request(app.getHttpServer());
  const auth = (who: Actor) => ({ Authorization: `Bearer ${who.token}` });

  const actor = async (first: string, options: { mfa: boolean }): Promise<Actor> => {
    const tag = randomUUID().slice(0, 8);
    const personId = await scalar<string>(
      dataSource,
      `INSERT INTO person (first_name, last_name, email, document_type, document_number, position_title)
       VALUES ($1, 'Entrega', $2, 'CC', $3, 'Funcionario de prueba') RETURNING id`,
      [first, `entrega.${tag}@unac.edu.co`, `6${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 1000)}`],
    );
    const userId = await scalar<string>(
      dataSource,
      `INSERT INTO app_user (person_id, username, password_hash, mfa_enabled, status) VALUES ($1, $2, 'x', $3, 'ACTIVE') RETURNING id`,
      [personId, `entrega.${tag}`, options.mfa],
    );
    const sessionId = randomUUID();
    await dataSource.query(
      `INSERT INTO refresh_token_family (id, user_id, current_jti, expires_at, mfa_verified_at)
       VALUES ($1, $2, $3, NOW() + interval '1 day', (SELECT CASE WHEN mfa_enabled THEN NOW() END FROM app_user WHERE id = $2))`,
      [sessionId, userId, randomUUID()],
    );
    const token = app.get(TokenService).signAccessToken({
      id: userId,
      personId,
      username: `entrega.${tag}`,
      roles: [],
      scopes: [],
      mustChangePassword: false,
      sessionId,
    });
    return { userId, personId, token, name: `${first} Entrega` };
  };

  const asset = async (options: { costCenterId?: string; status?: string } = {}) => {
    const tag = randomUUID().slice(0, 8).toUpperCase();
    const status = options.status ?? 'IN_USE';
    return scalar<string>(
      dataSource,
      `INSERT INTO asset (internal_code, description, category_id, acquisition_type_id, acquisition_date,
         current_cost_center_id, created_by, physical_condition, operational_status, written_off_at)
       VALUES ($1, $2, $3, (SELECT id FROM acquisition_type WHERE code = 'PURCHASE'), '2020-01-01', $4, $5, 'GOOD',
         $6::asset_operational_status, CASE WHEN $6 = 'WRITTEN_OFF' THEN DATE '2025-01-01' END)
       RETURNING id`,
      [`ENT-${tag}`, `ESCRITORIO DE PRUEBA ${tag}`, categoryId, options.costCenterId ?? costCenter, director.userId, status],
    );
  };

  const create = (assetIds: ReadonlyArray<string>, overrides: Record<string, unknown> = {}, who: Actor = director) =>
    http()
      .post('/api/v1/handovers')
      .set(auth(who))
      .send({
        assets: assetIds.map((assetId) => ({ assetId })),
        receiverPersonId: receiver.personId,
        costCenterId: costCenter,
        auditorPersonId: auditor.personId,
        ...overrides,
      });

  const detail = async (id: string) => (await http().get(`/api/v1/handovers/${id}`).set(auth(director)).expect(200)).body.data;

  const drain = () => engine.processPending(1000);

  const sign = (documentId: string, order: number, who: Actor) =>
    http().post(`/api/v1/documents/${documentId}/signatures/${order}`).set(auth(who)).send({ rubric });

  const responsibleOf = (assetId: string) =>
    scalar<string | null>(dataSource, 'SELECT current_responsible_id FROM asset WHERE id = $1', [assetId]);

  const assignments = (assetId: string) =>
    dataSource.query(
      `SELECT id, document_reference, from_responsible_id, to_responsible_id, requested_by, authorized_by, metadata
       FROM asset_movement WHERE asset_id = $1 AND movement_type = 'ASSIGNMENT' ORDER BY created_at`,
      [assetId],
    ) as Promise<
      Array<{
        id: string;
        document_reference: string;
        from_responsible_id: string | null;
        to_responsible_id: string;
        requested_by: string;
        authorized_by: string;
        metadata: Record<string, unknown>;
      }>
    >;

  const expectConforms = (method: string, route: string, status: number, body: unknown) => {
    const operation = (openapi.paths[route] as Record<string, { responses: Record<string, { content?: Record<string, { schema: Schema }> }> }>)[
      method
    ];
    const schema = operation?.responses[String(status)]?.content?.['application/json']?.schema;
    expect(schema, `${method.toUpperCase()} ${route} ${status} no declara esquema`).toBeDefined();
    const errors: string[] = [];
    conform(openapi, body, schema ?? {}, `${method.toUpperCase()} ${route}`, errors);
    expect(errors).toEqual([]);
  };

  /** Crea la entrega, genera el acta y devuelve la entrega con su documentId. */
  const generated = async (assetIds: ReadonlyArray<string>, overrides: Record<string, unknown> = {}) => {
    const created = (await create(assetIds, overrides).expect(201)).body.data;
    await drain();
    const handover = await detail(created.id);
    expect(handover.document.generation).toBe('GENERATED');
    return { id: created.id as string, documentId: handover.document.documentId as string, number: handover.document.number as string };
  };

  beforeAll(async () => {
    converter = new SwitchablePdfConverter();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PDF_CONVERTER)
      .useValue(converter)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    applyTrustProxy(app, app.get(ConfigService<AppConfig, true>).getOrThrow('trustProxy', { infer: true }));
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
    // El job del outbox corre cada minuto: se detiene para que el test decida cuándo se genera cada acta.
    for (const job of app.get(SchedulerRegistry).getCronJobs().values()) {
      await job.stop();
    }
    dataSource = app.get(DataSource);
    engine = app.get(DocumentEngineService);
    openapi = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    await useSharedStorage(dataSource);
    sequenceBefore = await scalar<string | undefined>(
      dataSource,
      `SELECT current_value FROM document_sequence WHERE format_key = $1 AND period = ''`,
      [FORMAT],
    );

    director = await actor('Directora', { mfa: true });
    await dataSource.query(
      `INSERT INTO user_role (user_id, role_id, scope_type) SELECT $1, id, 'GLOBAL' FROM role WHERE code = 'INTERNAL_CONTROL_DIRECTOR'`,
      [director.userId],
    );
    receiver = await actor('Receptora', { mfa: true });
    auditor = await actor('Auditora', { mfa: true });
    replacement = await actor('Reemplazo', { mfa: true });
    outsider = await actor('Ajeno', { mfa: true });
    rubric = `data:image/png;base64,${(await QRCode.toBuffer('rubrica', { width: 120 })).toString('base64')}`;
    const tag = randomUUID().slice(0, 6).toUpperCase();
    costCenter = await scalar<string>(
      dataSource,
      `INSERT INTO cost_center (external_code, name) VALUES ($1, 'Laboratorio de Entregas') RETURNING id`,
      [`E1${tag}`],
    );
    otherCostCenter = await scalar<string>(
      dataSource,
      `INSERT INTO cost_center (external_code, name) VALUES ($1, 'Biblioteca de Entregas') RETURNING id`,
      [`E2${tag}`],
    );
    categoryId = await scalar<string>(
      dataSource,
      `INSERT INTO asset_category (code, name, requires_photo) VALUES ($1, 'Muebles de entrega', FALSE) RETURNING id`,
      [`ENT_${tag}`],
    );
    // Vigencia antigua: si otro archivo ya subió su OCI-01-55 manda la suya; esta solo cubre que no haya ninguna.
    const uploaded = await engine.uploadTemplate(
      FORMAT,
      { buffer: await readFile(TEMPLATE), originalname: 'OCI-01-55-v2.docx' },
      { sgcVersion: '2', effectiveDate: '2026-01-15' },
      director.userId,
    );
    templateId = uploaded.id ?? '';
  });

  afterAll(async () => {
    // Deja OCI-01-55 como estaba: otros archivos esperan su consecutivo (0093...) y ninguna acta de más.
    const ids = (
      (await dataSource.query(`SELECT id FROM document WHERE entity_type = 'HANDOVER'`)) as Array<{ id: string }>
    ).map((item) => item.id);
    await dataSource.query('DELETE FROM asset_handover_item');
    await dataSource.query('DELETE FROM asset_handover');
    await dataSource.query('DELETE FROM document_signature_reassignment WHERE document_id = ANY($1)', [ids]);
    await dataSource.query(
      'DELETE FROM signature_envelope_signer WHERE envelope_id IN (SELECT id FROM signature_envelope WHERE document_id = ANY($1))',
      [ids],
    );
    await dataSource.query('DELETE FROM signature_envelope WHERE document_id = ANY($1)', [ids]);
    await dataSource.query(`DELETE FROM document_request WHERE payload->>'entityType' = 'HANDOVER'`);
    await dataSource.query('DELETE FROM document WHERE id = ANY($1)', [ids]);
    await dataSource.query('DELETE FROM document_template_version WHERE id = $1', [templateId || null]);
    await dataSource.query('DELETE FROM document_sequence WHERE format_key = $1', [FORMAT]);
    if (sequenceBefore !== undefined) {
      await dataSource.query(`INSERT INTO document_sequence (format_key, period, current_value) VALUES ($1, '', $2)`, [
        FORMAT,
        sequenceBefore,
      ]);
    }
    await app.close();
  });

  it('flujo completo: crear → generar → firmar RECIBE y AUDITA → responsable asignado, con movimiento ASSIGNMENT enlazado al acta', async () => {
    const first = await asset();
    const second = await asset();
    const created = await http()
      .post('/api/v1/handovers')
      .set(auth(director))
      .send({
        assets: [{ assetId: first, note: 'Con cargador' }, { assetId: second }],
        receiverPersonId: receiver.personId,
        costCenterId: costCenter,
        auditorPersonId: auditor.personId,
      })
      .expect(201);
    expectConforms('post', '/api/v1/handovers', 201, created.body);
    const pending = created.body.data;
    expect(pending).toMatchObject({
      status: 'AWAITING_DOCUMENT',
      receiver: { id: receiver.personId, name: receiver.name },
      auditor: { id: auditor.personId },
      assignedPerson: null,
      closedAt: null,
      costCenter: { id: costCenter, name: 'Laboratorio de Entregas' },
      createdBy: { userId: director.userId, name: director.name },
      document: { generation: 'PENDING', documentId: null, number: null, status: null, lastError: null, retryable: false, signatures: [] },
    });
    expect(pending.items.map((item: { lineNumber: number; asset: { id: string }; note: string | null }) => [item.lineNumber, item.asset.id, item.note])).toEqual([
      [1, first, 'Con cargador'],
      [2, second, null],
    ]);

    await drain();
    const generatedHandover = await detail(pending.id);
    expect(generatedHandover.status).toBe('PENDING_SIGNATURE');
    expect(generatedHandover.document).toMatchObject({ generation: 'GENERATED', status: 'PENDING_SIGNATURE', lifecycleError: null });
    const { documentId, number } = generatedHandover.document;
    expect(number).toMatch(/^\d{4}$/);
    expect(
      generatedHandover.document.signatures.map((signature: { order: number; role: string; personId: string; status: string }) => [
        signature.order,
        signature.role,
        signature.personId,
        signature.status,
      ]),
    ).toEqual([
      [1, 'RECIBE', receiver.personId, 'PENDING'],
      [2, 'AUDITA', auditor.personId, 'PENDING'],
    ]);
    const data = (
      (await dataSource.query('SELECT data FROM document WHERE id = $1', [documentId])) as Array<{
        data: { activos: Array<{ id: string; observacion: string }>; centroCosto: { nombre: string } };
      }>
    )[0]?.data;
    expect(data?.activos.map((item) => [item.id, item.observacion])).toEqual([
      [first, 'Con cargador'],
      [second, ''],
    ]);
    expect(data?.centroCosto.nombre).toBe('Laboratorio de Entregas');

    // Antes de firmar nada cambió en los activos.
    expect(await responsibleOf(first)).toBeNull();
    await sign(documentId, 2, auditor).expect(409);
    await sign(documentId, 1, receiver).expect(200);
    expect((await detail(pending.id)).status).toBe('PENDING_SIGNATURE');
    expect(await responsibleOf(first)).toBeNull();
    const done = (await sign(documentId, 2, auditor).expect(200)).body.data;
    expect(done).toMatchObject({ status: 'SIGNED', lifecycleError: null });

    const signed = await detail(pending.id);
    expect(signed).toMatchObject({
      status: 'SIGNED',
      assignedPerson: { id: receiver.personId, name: receiver.name },
      document: { status: 'SIGNED', number, documentId },
    });
    expect(signed.closedAt).not.toBeNull();
    expect(signed.document.signedAt).not.toBeNull();
    for (const assetId of [first, second]) {
      expect(await responsibleOf(assetId)).toBe(receiver.personId);
      const [movement, ...extra] = await assignments(assetId);
      expect(extra).toEqual([]);
      expect(movement).toMatchObject({
        document_reference: number,
        from_responsible_id: null,
        to_responsible_id: receiver.personId,
        requested_by: director.userId,
        authorized_by: auditor.userId,
        metadata: expect.objectContaining({ handoverId: pending.id, documentId }),
      });
      // Enlace en ambos sentidos: ítem de la entrega → movimiento, acta (document_asset) → movimiento.
      const item = signed.items.find((entry: { asset: { id: string } }) => entry.asset.id === assetId);
      expect(item.movementId).toBe(movement?.id);
      expect(item.asset.responsibleId).toBe(receiver.personId);
      expect(
        await scalar<string>(dataSource, 'SELECT movement_id FROM document_asset WHERE document_id = $1 AND asset_id = $2', [
          documentId,
          assetId,
        ]),
      ).toBe(movement?.id);
    }
    expectConforms('get', '/api/v1/handovers/{id}', 200, (await http().get(`/api/v1/handovers/${pending.id}`).set(auth(director))).body);

    // El activo quedó libre: puede entrar en otra entrega.
    await create([first]).expect(201);
  });

  it('si el turno RECIBE se reasigna antes de firmar, el responsable asignado es el firmante final, no el receptor original', async () => {
    const assetId = await asset();
    const handover = await generated([assetId]);
    await http()
      .post(`/api/v1/documents/${handover.documentId}/signatures/1/reassign`)
      .set(auth(director))
      .send({ personId: replacement.personId, reason: 'La receptora designada está de licencia' })
      .expect(200);
    const firmante = await scalar<{ recibe: { nombre: string } }>(
      dataSource,
      `SELECT data->'firmante' FROM document WHERE id = $1`,
      [handover.documentId],
    );
    expect(firmante.recibe.nombre).toBe(replacement.name);

    await sign(handover.documentId, 1, receiver).expect(403);
    await sign(handover.documentId, 1, replacement).expect(200);
    await sign(handover.documentId, 2, auditor).expect(200);

    const signed = await detail(handover.id);
    expect(signed).toMatchObject({
      status: 'SIGNED',
      receiver: { id: receiver.personId },
      assignedPerson: { id: replacement.personId, name: replacement.name },
    });
    expect(await responsibleOf(assetId)).toBe(replacement.personId);
    expect((await assignments(assetId)).map((movement) => movement.to_responsible_id)).toEqual([replacement.personId]);
  });

  it('un fallo de generación deja la entrega intacta y visible con el error; el reintento la genera', async () => {
    const assetId = await asset();
    const created = (await create([assetId]).expect(201)).body.data;
    converter.failing = true;
    try {
      await drain();
    } finally {
      converter.failing = false;
    }
    const failed = await detail(created.id);
    expect(failed).toMatchObject({
      status: 'AWAITING_DOCUMENT',
      items: [expect.objectContaining({ asset: expect.objectContaining({ id: assetId }), movementId: null })],
      document: {
        generation: 'FAILED',
        attempts: 1,
        lastError: 'conversión simulada caída',
        retriesAutomatically: true,
        retryable: true,
        documentId: null,
        number: null,
        status: null,
      },
    });
    const listed = (await http().get('/api/v1/handovers?status=AWAITING_DOCUMENT&pageSize=100').set(auth(director)).expect(200)).body;
    expectConforms('get', '/api/v1/handovers', 200, listed);
    expect(listed.data.items.find((item: { id: string }) => item.id === created.id)).toMatchObject({
      generation: 'FAILED',
      generationError: 'conversión simulada caída',
      documentId: null,
      assetCount: 1,
    });
    // Sigue abierta: el activo no entra en otra entrega mientras tanto.
    const blocked = await create([assetId]).expect(409);
    expect(blocked.body.error.code).toBe('HANDOVER_ASSET_IN_OPEN_HANDOVER');

    await http().post(`/api/v1/documents/requests/${failed.document.requestId}/retry`).set(auth(director)).expect(200);
    await drain();
    const recovered = await detail(created.id);
    expect(recovered).toMatchObject({
      status: 'PENDING_SIGNATURE',
      document: { generation: 'GENERATED', attempts: 2, lastError: null, retryable: false, status: 'PENDING_SIGNATURE' },
    });
    expect(recovered.document.documentId).not.toBeNull();
    expect(await responsibleOf(assetId)).toBeNull();
  });

  it('si aplicar la entrega falla dentro de onSigned, ningún activo cambia y el acta no queda SIGNED; al corregirse se aplica', async () => {
    const [low, high] = [await asset(), await asset()].sort();
    const handover = await generated([low ?? '', high ?? '']);
    await sign(handover.documentId, 1, receiver).expect(200);
    // El segundo activo (en orden de aplicación) cambia de centro mientras el acta espera la firma de Control Interno.
    await dataSource.query('UPDATE asset SET current_cost_center_id = $2 WHERE id = $1', [high, otherCostCenter]);

    const stalled = (await sign(handover.documentId, 2, auditor).expect(200)).body.data;
    expect(stalled.status).toBe('PENDING_SIGNATURE');
    expect(stalled.lifecycleError).toMatch(/^HANDOVER\.onSigned: El activo ENT-.* cambió de centro de costo/);
    const blocked = await detail(handover.id);
    expect(blocked).toMatchObject({ status: 'PENDING_SIGNATURE', assignedPerson: null, closedAt: null });
    expect(blocked.document.lifecycleError).toBe(stalled.lifecycleError);
    expect(blocked.document.signatures.map((signature: { status: string }) => signature.status)).toEqual(['SIGNED', 'SIGNED']);
    // El primer activo alcanzó a aplicarse dentro de la transacción y se revirtió con ella.
    for (const assetId of [low ?? '', high ?? '']) {
      expect(await responsibleOf(assetId)).toBeNull();
      expect(await assignments(assetId)).toEqual([]);
    }
    expect(
      await scalar<number>(dataSource, 'SELECT count(*)::int FROM document_asset WHERE document_id = $1 AND movement_id IS NOT NULL', [
        handover.documentId,
      ]),
    ).toBe(0);

    await dataSource.query('UPDATE asset SET current_cost_center_id = $2 WHERE id = $1', [high, costCenter]);
    const synced = (await http().post(`/api/v1/documents/${handover.documentId}/signatures/sync`).set(auth(director)).expect(200)).body.data;
    expect(synced).toMatchObject({ status: 'SIGNED', lifecycleError: null });
    expect(await responsibleOf(low ?? '')).toBe(receiver.personId);
    expect(await responsibleOf(high ?? '')).toBe(receiver.personId);
    expect((await detail(handover.id)).status).toBe('SIGNED');
  });

  it('el rechazo cierra la entrega sin tocar los activos y los libera para otra entrega', async () => {
    const assetId = await asset();
    const handover = await generated([assetId]);
    await http()
      .post(`/api/v1/documents/${handover.documentId}/signatures/1/reject`)
      .set(auth(receiver))
      .send({ reason: 'El escritorio no corresponde al que recibí' })
      .expect(200);
    const rejected = await detail(handover.id);
    expect(rejected).toMatchObject({ status: 'REJECTED', assignedPerson: null, document: { status: 'REJECTED' } });
    expect(rejected.closedAt).not.toBeNull();
    expect(rejected.items[0].movementId).toBeNull();
    expect(await responsibleOf(assetId)).toBeNull();
    expect(await assignments(assetId)).toEqual([]);
    await create([assetId]).expect(201);
  });

  it('rechaza lo inválido sin crear entrega: activo en entrega abierta, otro centro, dado de baja, en préstamo, repetido o inexistente', async () => {
    const open = await asset();
    await create([open]).expect(201);
    const count = () => scalar<number>(dataSource, 'SELECT count(*)::int FROM asset_handover');
    const before = await count();
    const requestsBefore = await scalar<number>(dataSource, `SELECT count(*)::int FROM document_request WHERE payload->>'entityType' = 'HANDOVER'`);

    const free = await asset();
    const inOpen = await create([free, open]).expect(409);
    expect(inOpen.body.error.code).toBe('HANDOVER_ASSET_IN_OPEN_HANDOVER');
    expect(inOpen.body.error.details).toHaveLength(1);

    const elsewhere = await asset({ costCenterId: otherCostCenter });
    const mismatch = await create([free, elsewhere]).expect(406);
    expect(mismatch.body.error.code).toBe('HANDOVER_COST_CENTER_MISMATCH');
    expect(mismatch.body.error.details[0].message).toContain(elsewhere);
    expect(await scalar<string>(dataSource, 'SELECT current_cost_center_id FROM asset WHERE id = $1', [elsewhere])).toBe(otherCostCenter);

    for (const status of ['WRITTEN_OFF', 'ON_LOAN']) {
      const response = await create([await asset({ status })]).expect(406);
      expect(response.body.error.code).toBe('HANDOVER_ASSET_NOT_DELIVERABLE');
      expect(response.body.error.details[0].message).toContain(status);
    }

    expect((await create([free, free]).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    expect((await create([randomUUID()]).expect(404)).body.error.code).toBe('RESOURCE_NOT_FOUND');
    expect((await create([free], { receiverPersonId: randomUUID() }).expect(404)).body.error.details).toEqual([
      { field: 'receiverPersonId', message: 'No existe la persona que recibe' },
    ]);
    expect((await create([free], { auditorPersonId: randomUUID() }).expect(404)).body.error.code).toBe('RESOURCE_NOT_FOUND');
    expect((await create([free], { costCenterId: randomUUID() }).expect(404)).body.error.code).toBe('RESOURCE_NOT_FOUND');
    expect((await create([]).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    expect((await create([free], {}, outsider).expect(403)).body.error.code).toBe('INSUFFICIENT_PERMISSIONS');

    expect(await count()).toBe(before);
    expect(
      await scalar<number>(dataSource, `SELECT count(*)::int FROM document_request WHERE payload->>'entityType' = 'HANDOVER'`),
    ).toBe(requestsBefore);
  });

  it('dos entregas simultáneas del mismo activo: una se crea y la otra choca con la entrega abierta', async () => {
    const assetId = await asset();
    const responses = await Promise.all([create([assetId]), create([assetId])]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(responses.find((response) => response.status === 409)?.body.error.code).toBe('HANDOVER_ASSET_IN_OPEN_HANDOVER');
    expect(await scalar<number>(dataSource, 'SELECT count(*)::int FROM asset_handover_item WHERE asset_id = $1', [assetId])).toBe(1);
  });

  it('la lista pagina y filtra por estado; leer exige asset:read:global', async () => {
    const page = (await http().get('/api/v1/handovers?page=1&pageSize=2').set(auth(director)).expect(200)).body;
    expectConforms('get', '/api/v1/handovers', 200, page);
    expect(page.data.items).toHaveLength(2);
    expect(page.data.total).toBeGreaterThan(2);
    expect(page.data.hasNext).toBe(true);
    const signed = (await http().get('/api/v1/handovers?status=SIGNED&pageSize=100').set(auth(director)).expect(200)).body.data;
    expect(signed.items.length).toBeGreaterThanOrEqual(3);
    expect(signed.items.every((item: { status: string; assignedPerson: unknown }) => item.status === 'SIGNED' && item.assignedPerson !== null)).toBe(true);
    await http().get('/api/v1/handovers?status=OTRO').set(auth(director)).expect(400);
    await http().get('/api/v1/handovers').set(auth(outsider)).expect(403);
    await http().get(`/api/v1/handovers/${randomUUID()}`).set(auth(director)).expect(404);
  });

  it('GET /persons busca por nombre o documento y dice si la persona puede firmar (usuario activo con MFA)', async () => {
    const withoutUser = await scalar<string>(
      dataSource,
      `INSERT INTO person (first_name, last_name, email, document_number) VALUES ('Zacarías', 'Sin Cuenta', $1, $2) RETURNING id`,
      [`sin.cuenta.${randomUUID().slice(0, 6)}@unac.edu.co`, `55${Date.now().toString().slice(-8)}`],
    );
    const noMfa = await actor('Nomfa', { mfa: false });
    const inactive = await scalar<string>(
      dataSource,
      `INSERT INTO person (first_name, last_name, email, is_active) VALUES ('Zacarías', 'Inactivo', $1, FALSE) RETURNING id`,
      [`inactivo.${randomUUID().slice(0, 6)}@unac.edu.co`],
    );

    const byName = (await http().get('/api/v1/persons?search=zacar').set(auth(director)).expect(200)).body;
    expectConforms('get', '/api/v1/persons', 200, byName);
    const ids = byName.data.items.map((item: { id: string }) => item.id);
    expect(ids).toContain(withoutUser);
    expect(ids).not.toContain(inactive);
    expect(byName.data.items.find((item: { id: string }) => item.id === withoutUser)).toEqual({
      id: withoutUser,
      name: 'Zacarías Sin Cuenta',
      documentNumber: expect.any(String),
      positionTitle: null,
      email: expect.stringMatching(/^sin\.cuenta\./),
      hasActiveUser: false,
      mfaEnabled: false,
    });

    const document = await scalar<string>(dataSource, 'SELECT document_number FROM person WHERE id = $1', [noMfa.personId]);
    const byDocument = (await http().get(`/api/v1/persons?search=${document.slice(0, 6)}`).set(auth(director)).expect(200)).body.data;
    expect(byDocument.items.find((item: { id: string }) => item.id === noMfa.personId)).toMatchObject({ hasActiveUser: true, mfaEnabled: false });
    const signer = (await http().get(`/api/v1/persons?search=Receptora`).set(auth(director)).expect(200)).body.data;
    expect(signer.items.find((item: { id: string }) => item.id === receiver.personId)).toMatchObject({ hasActiveUser: true, mfaEnabled: true });

    const paged = (await http().get('/api/v1/persons?page=1&pageSize=1').set(auth(director)).expect(200)).body.data;
    expect(paged.items).toHaveLength(1);
    expect(paged.hasNext).toBe(true);
    expect((await http().get('/api/v1/persons?search=%25').set(auth(director)).expect(200)).body.data.items).toEqual([]);
    const denied = await http().get('/api/v1/persons').set(auth(outsider)).expect(403);
    expect(denied.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
  });
});
