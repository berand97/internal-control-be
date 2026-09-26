// Préstamo temporal y devolución (OCI-01-65) sobre el outbox del motor de documentos.
// HTTP real (AppModule) + PostgreSQL real. Sin Gotenberg: el PDF se arma con el texto del DOCX (DocxTextPdfConverter)
// y los marcadores del acta se leen del DOCX renderizado con la plantilla real templates/formats/OCI-01-65-v2.docx.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import PizZip from 'pizzip';
import QRCode from 'qrcode';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { createAppValidationPipe } from '../../src/common/pipes/app-validation.pipe.js';
import { TokenService } from '../../src/modules/auth/services/token.service.js';
import { PDF_CONVERTER } from '../../src/modules/documents/pdf/pdf-converter.js';
import { DocumentEngineService } from '../../src/modules/documents/services/document-engine.service.js';
import { bogotaDate, longSpanishDate, usageBetween } from '../../src/modules/loans/domain/loan-dates.js';
import { LoansService } from '../../src/modules/loans/services/loans.service.js';
import { StorageService } from '../../src/shared/storage/storage.service.js';
import { scalar, useSharedStorage } from './helpers.js';
import { DocxTextPdfConverter } from './pdf-text.js';

const FORMAT = 'OCI-01-65';
const TEMPLATE = 'templates/formats/OCI-01-65-v2.docx';

interface User {
  userId: string;
  personId: string;
  token: string;
  documentNumber: string;
  fullName: string;
  title: string;
}

interface Schema {
  readonly $ref?: string;
  readonly allOf?: ReadonlyArray<Schema>;
  readonly type?: string;
  readonly nullable?: boolean;
  readonly enum?: ReadonlyArray<unknown>;
  readonly properties?: Record<string, Schema>;
  readonly additionalProperties?: unknown;
  readonly required?: ReadonlyArray<string>;
  readonly items?: Schema;
}

/** Igual que document-openapi.int-spec.ts, más additionalProperties (payload libre de los eventos). */
const conform = (openapi: OpenAPIObject, value: unknown, schema: Schema, path: string, errors: string[]): void => {
  const components = (openapi.components?.schemas ?? {}) as Record<string, Schema>;
  const resolve = (item: Schema): Schema => {
    if (item.$ref) {
      return resolve(components[item.$ref.replace('#/components/schemas/', '')] ?? {});
    }
    const { allOf, ...own } = item;
    if (allOf) {
      const parts = [...allOf.map(resolve), own];
      return parts.reduce<Schema>(
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
    if (!resolved.additionalProperties) {
      for (const key of Object.keys(value)) {
        if (!(key in declared)) {
          errors.push(`${path}.${key}: la respuesta la trae y el esquema no la declara`);
        }
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
  const expected: Record<string, (item: unknown) => boolean> = {
    string: (item) => typeof item === 'string',
    integer: (item) => Number.isInteger(item),
    number: (item) => typeof item === 'number',
    boolean: (item) => typeof item === 'boolean',
  };
  if (type && expected[type] && !expected[type](value)) {
    errors.push(`${path}: se esperaba ${type} y llegó ${typeof value}`);
  }
  if (!type && !resolved.enum) {
    errors.push(`${path}: el esquema no declara tipo (queda como Object en el cliente generado)`);
  }
};

const PARTS = /^word\/(document|header\d*|footer\d*)\.xml$/;

/** Párrafos del DOCX, como en oci-01-65-template.int-spec.ts. */
const paragraphs = (docx: Buffer): string[] => {
  const zip = new PizZip(docx);
  return Object.keys(zip.files)
    .filter((name) => PARTS.test(name))
    .flatMap((name) =>
      [...(zip.file(name)?.asText() ?? '').matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((match) =>
        [...match[0].replace(/<w:pPr>[\s\S]*?<\/w:pPr>/g, '').matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>|<w:tab\/>/g)]
          .map((item) => item[1] ?? '\t')
          .join('')
          .replaceAll('&amp;', '&')
          .replaceAll('&lt;', '<')
          .replaceAll('&gt;', '>'),
      ),
    );
};

const addDays = (iso: string, days: number): string => {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

describe('Préstamos: entrega transaccional, acta OCI-01-65 por el outbox, aprobación por alcance y devolución (HTTP + PostgreSQL real)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let engine: DocumentEngineService;
  let openapi: OpenAPIObject;
  let rubric: string;
  let centerA: string;
  let centerB: string;
  let categoryId: string;
  let creatorId: string;
  let templateId = '';
  let sequencesBefore: Array<{ period: string; current_value: string }> = [];
  const loanIds: string[] = [];
  const users: Record<string, User> = {};
  const tag = randomUUID().slice(0, 6).toUpperCase();

  const http = () => request(app.getHttpServer());
  const auth = (who: string) => ({ Authorization: `Bearer ${users[who]?.token ?? ''}` });
  const drain = () => engine.processPending(1000);

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

  const user = async (
    name: string,
    first: string,
    title: string,
    roles: ReadonlyArray<{ role: string; scopeType: 'GLOBAL' | 'COST_CENTER'; scopeId?: string }>,
  ) => {
    const suffix = randomUUID().slice(0, 8);
    const documentNumber = `5${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 1000)}`;
    const personId = await scalar<string>(
      dataSource,
      `INSERT INTO person (first_name, last_name, email, document_type, document_number, position_title)
       VALUES ($1, 'Prestamo', $2, 'CC', $3, $4) RETURNING id`,
      [first, `prestamo.${suffix}@unac.edu.co`, documentNumber, title],
    );
    const userId = await scalar<string>(
      dataSource,
      `INSERT INTO app_user (person_id, username, password_hash, mfa_enabled, status) VALUES ($1, $2, 'x', TRUE, 'ACTIVE') RETURNING id`,
      [personId, `prestamo.${suffix}`],
    );
    const sessionId = randomUUID();
    await dataSource.query(
      `INSERT INTO refresh_token_family (id, user_id, current_jti, expires_at, mfa_verified_at)
       VALUES ($1, $2, $3, NOW() + interval '1 day', (SELECT CASE WHEN mfa_enabled THEN NOW() END FROM app_user WHERE id = $2))`,
      [sessionId, userId, randomUUID()],
    );
    for (const assignment of roles) {
      await dataSource.query(
        `INSERT INTO user_role (user_id, role_id, scope_type, scope_id) SELECT $1, id, $2, $3 FROM role WHERE code = $4`,
        [userId, assignment.scopeType, assignment.scopeId ?? null, assignment.role],
      );
    }
    const token = app.get(TokenService).signAccessToken({
      id: userId,
      personId,
      username: `prestamo.${suffix}`,
      roles: [],
      scopes: [],
      mustChangePassword: false,
      sessionId,
    });
    users[name] = { userId, personId, token, documentNumber, fullName: `${first} Prestamo`, title };
  };

  const asset = (code: string, description: string) =>
    scalar<string>(
      dataSource,
      `INSERT INTO asset (internal_code, description, category_id, acquisition_type_id, acquisition_date,
         current_cost_center_id, physical_condition, created_by)
       VALUES ($1, $2, $3, (SELECT id FROM acquisition_type WHERE code = 'PURCHASE'), '2022-05-01', $4, 'GOOD', $5)
       RETURNING id`,
      [code, description, categoryId, centerA, creatorId],
    );

  /** Solicitud por HTTP (solicitante) → préstamo REQUESTED. */
  const requestLoan = async (assets: string[], expectedReturnDate: string) => {
    const response = await http()
      .post('/api/v1/loans')
      .set(auth('solicitante'))
      .send({
        assets,
        targetCostCenterId: centerB,
        expectedReturnDate,
        justification: 'Préstamo para el laboratorio de idiomas del segundo semestre',
        contactPerson: users['recibe']?.personId,
      })
      .expect(201);
    expectConforms('post', '/api/v1/loans', 201, response.body);
    const id = response.body.data.id as string;
    loanIds.push(id);
    return id;
  };

  const approve = (id: string, who: string) => http().post(`/api/v1/loans/${id}/approve`).set(auth(who)).send({});

  const deliver = (id: string) =>
    http()
      .post(`/api/v1/loans/${id}/deliver`)
      .set(auth('director'))
      .send({ deliveredByPersonId: users['entrega']?.personId, controlInternoPersonId: users['audita']?.personId });

  const detail = async (id: string) => {
    const response = await http().get(`/api/v1/loans/${id}`).set(auth('director')).expect(200);
    expectConforms('get', '/api/v1/loans/{id}', 200, response.body);
    return response.body.data;
  };

  const assetRow = async (id: string) =>
    (
      (await dataSource.query('SELECT operational_status, physical_condition FROM asset WHERE id = $1', [id])) as Array<{
        operational_status: string;
        physical_condition: string | null;
      }>
    )[0];

  const movements = (assetIds: string[]) =>
    dataSource.query(
      `SELECT id, asset_id, movement_type, executed_at, metadata, to_operational_status, loan_id
       FROM asset_movement WHERE asset_id = ANY($1) ORDER BY created_at`,
      [assetIds],
    ) as Promise<
      Array<{
        id: string;
        asset_id: string;
        movement_type: string;
        executed_at: Date;
        metadata: Record<string, unknown>;
        to_operational_status: string;
        loan_id: string | null;
      }>
    >;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PDF_CONVERTER)
      .useValue(new DocxTextPdfConverter())
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
    dataSource = app.get(DataSource);
    engine = app.get(DocumentEngineService);
    await useSharedStorage(dataSource);
    openapi = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    rubric = `data:image/png;base64,${(await QRCode.toBuffer('rubrica', { width: 120 })).toString('base64')}`;
    sequencesBefore = (await dataSource.query(
      'SELECT period, current_value FROM document_sequence WHERE format_key = $1',
      [FORMAT],
    )) as typeof sequencesBefore;

    centerA = await scalar<string>(
      dataSource,
      `INSERT INTO cost_center (external_code, name) VALUES ($1, 'CENTRO DE IDIOMAS PRUEBA') RETURNING id`,
      [`LA-${tag}`],
    );
    centerB = await scalar<string>(
      dataSource,
      `INSERT INTO cost_center (external_code, name) VALUES ($1, 'FACULTAD DESTINO PRUEBA') RETURNING id`,
      [`LB-${tag}`],
    );
    categoryId = await scalar<string>(
      dataSource,
      `INSERT INTO asset_category (code, name) VALUES ($1, 'Préstamos') RETURNING id`,
      [`LOAN-${tag}`],
    );
    await user('director', 'Directora', 'Directora de Control Interno', [{ role: 'INTERNAL_CONTROL_DIRECTOR', scopeType: 'GLOBAL' }]);
    creatorId = users['director']?.userId ?? '';
    await user('solicitante', 'Solicitante', 'Coordinador académico', [{ role: 'INTERNAL_CONTROL_DIRECTOR', scopeType: 'GLOBAL' }]);
    await user('jefeA', 'JefeOrigen', 'Jefe Centro de Idiomas', [
      { role: 'DEPARTMENT_HEAD', scopeType: 'COST_CENTER', scopeId: centerA },
    ]);
    await user('jefeB', 'JefeDestino', 'Decano', [{ role: 'DEPARTMENT_HEAD', scopeType: 'COST_CENTER', scopeId: centerB }]);
    await user('jefeGlobal', 'JefeGlobal', 'Jefe', [{ role: 'DEPARTMENT_HEAD', scopeType: 'GLOBAL' }]);
    await user('custodio', 'Custodio', 'Auxiliar', [{ role: 'CUSTODIAN', scopeType: 'COST_CENTER', scopeId: centerA }]);
    await user('entrega', 'Entregadora', 'JEFE CENTRO DE IDIOMAS', []);
    await user('recibe', 'Receptor', 'DOCENTE AULA', []);
    await user('audita', 'Auditora', 'PROFESIONAL DE CONTROL INTERNO', []);
  });

  afterAll(async () => {
    // OCI-01-65 queda como estaba: sin esta plantilla (document-lifecycle sube la suya con la misma fecha) y con su consecutivo.
    const ids = (
      (await dataSource.query(`SELECT id FROM document WHERE format_key = $1 AND entity_type = 'LOAN'`, [FORMAT])) as Array<{
        id: string;
      }>
    ).map((item) => item.id);
    await dataSource.query('UPDATE asset_loan SET delivery_document_id = NULL WHERE id = ANY($1)', [loanIds]);
    await dataSource.query(
      `DELETE FROM signature_envelope_signer WHERE envelope_id IN (SELECT id FROM signature_envelope WHERE document_id = ANY($1))`,
      [ids],
    );
    await dataSource.query('DELETE FROM signature_envelope WHERE document_id = ANY($1)', [ids]);
    await dataSource.query(`DELETE FROM document_request WHERE payload->>'entityType' = 'LOAN'`);
    await dataSource.query('DELETE FROM document WHERE id = ANY($1)', [ids]);
    await dataSource.query('DELETE FROM document_template_version WHERE id = $1', [templateId || null]);
    await dataSource.query('DELETE FROM document_sequence WHERE format_key = $1', [FORMAT]);
    for (const sequence of sequencesBefore) {
      await dataSource.query('INSERT INTO document_sequence (format_key, period, current_value) VALUES ($1, $2, $3)', [
        FORMAT,
        sequence.period,
        sequence.current_value,
      ]);
    }
    await app.close();
  });

  it('aprobación: director (global) y jefe del centro de ORIGEN aprueban; jefe de otro centro 404; solicitante 403; sin centros 403', async () => {
    const today = bogotaDate(new Date());
    const [a1, a2] = [await asset(`LP-${tag}-A01`, 'VIDEOBEAM APROBACION'), await asset(`LP-${tag}-A02`, 'PORTATIL APROBACION')];
    const byDirector = await requestLoan([a1 ?? ''], addDays(today, 30));
    const byHead = await requestLoan([a2 ?? ''], addDays(today, 30));

    // Solicitante (tiene loan:approve:global) no aprueba lo que pidió: regla SoD.
    const own = await approve(byDirector, 'solicitante');
    expect([own.status, own.body.error.code]).toEqual([403, 'LOAN_SOD_VIOLATION']);

    // Jefe del centro de destino: tiene loan:approve:org_unit pero no sobre el origen → igual que inexistente.
    const other = await approve(byHead, 'jefeB');
    const missing = await approve(randomUUID(), 'jefeB');
    expect(other.status).toBe(404);
    expect(other.body).toEqual(missing.body);
    expect(other.body.error.code).toBe('RESOURCE_NOT_FOUND');
    const otherReject = await http().post(`/api/v1/loans/${byHead}/reject`).set(auth('jefeB')).send({ reason: 'No corresponde' });
    expect(otherReject.status).toBe(404);

    // Rol acotado asignado con alcance GLOBAL: no da centros (decisión de la ola anterior).
    const global = await approve(byHead, 'jefeGlobal');
    expect([global.status, global.body.error.code]).toEqual([403, 'SCOPE_NO_COST_CENTER']);
    // Sin ningún permiso de aprobación.
    const custodian = await approve(byHead, 'custodio');
    expect([custodian.status, custodian.body.error.code]).toEqual([403, 'INSUFFICIENT_PERMISSIONS']);

    const head = await approve(byHead, 'jefeA');
    expect(head.status).toBe(200);
    expectConforms('post', '/api/v1/loans/{id}/approve', 200, head.body);
    expect(head.body.data).toMatchObject({ status: 'APPROVED', approvedBy: users['jefeA']?.userId });

    const director = await approve(byDirector, 'director');
    expect(director.status).toBe(200);
    expect(director.body.data).toMatchObject({ status: 'APPROVED', approvedBy: users['director']?.userId });

    // Rechazo: misma regla; el jefe del origen rechaza uno nuevo.
    const toReject = await requestLoan([await asset(`LP-${tag}-A03`, 'TABLERO RECHAZO')], addDays(today, 10));
    const rejected = await http()
      .post(`/api/v1/loans/${toReject}/reject`)
      .set(auth('jefeA'))
      .send({ reason: 'No hay disponibilidad' })
      .expect(200);
    expectConforms('post', '/api/v1/loans/{id}/reject', 200, rejected.body);
    expect(rejected.body.data).toMatchObject({ status: 'REJECTED', rejectedReason: 'No hay disponibilidad' });
    expect((await detail(toReject)).events.map((event: { eventType: string }) => event.eventType)).toEqual([
      'REQUESTED',
      'REJECTED',
    ]);
  });

  it('entrega transaccional: si un activo falla a mitad, nada cambia (activos, movimientos, préstamo, eventos, outbox)', async () => {
    const first = await asset(`LP-${tag}-B01`, 'CAMARA ENTREGA FALLIDA');
    const second = await asset(`LP-${tag}-B02`, 'TRIPODE ENTREGA FALLIDA');
    const id = await requestLoan([first, second], addDays(bogotaDate(new Date()), 20));
    await approve(id, 'director').expect(200);
    // El segundo (por código) deja de estar disponible después de aprobado: el primero ya habría pasado a ON_LOAN.
    await dataSource.query(`UPDATE asset SET operational_status = 'IN_MAINTENANCE' WHERE id = $1`, [second]);

    const response = await deliver(id);
    expect([response.status, response.body.error.code]).toEqual([406, 'ASSET_CANNOT_BE_MODIFIED']);
    expect(response.body.error.message).toContain(`LP-${tag}-B02`);

    expect(await assetRow(first)).toMatchObject({ operational_status: 'IN_USE' });
    expect(await assetRow(second)).toMatchObject({ operational_status: 'IN_MAINTENANCE' });
    expect(await movements([first, second])).toEqual([]);
    const loan = await detail(id);
    expect(loan).toMatchObject({ status: 'APPROVED', deliveredAt: null, deliveryDocumentId: null });
    expect(loan.deliveryAct).toMatchObject({ status: 'NONE', requestId: null });
    expect(loan.events.map((event: { eventType: string }) => event.eventType)).toEqual(['REQUESTED', 'APPROVED']);
    expect(
      await scalar<number>(dataSource, `SELECT count(*)::int FROM document_request WHERE payload->>'entityId' = $1`, [id]),
    ).toBe(0);

    // Firmantes inexistentes: 404 antes de tocar nada.
    await dataSource.query(`UPDATE asset SET operational_status = 'IN_USE' WHERE id = $1`, [second]);
    const ghost = await http()
      .post(`/api/v1/loans/${id}/deliver`)
      .set(auth('director'))
      .send({ deliveredByPersonId: randomUUID(), controlInternoPersonId: users['audita']?.personId });
    expect([ghost.status, ghost.body.error.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
    expect(await movements([first, second])).toEqual([]);
    // Sin firmantes en el body: 400 (el frontend hoy envía {}).
    const empty = await http().post(`/api/v1/loans/${id}/deliver`).set(auth('director')).send({});
    expect([empty.status, empty.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);
  });

  it('dos entregas concurrentes del mismo préstamo: una gana, la otra 406, sin movimientos ni actas duplicadas', async () => {
    const assets = [await asset(`LP-${tag}-C01`, 'PARLANTE CONCURRENTE'), await asset(`LP-${tag}-C02`, 'MICROFONO CONCURRENTE')];
    const id = await requestLoan(assets, addDays(bogotaDate(new Date()), 15));
    await approve(id, 'director').expect(200);

    const results = await Promise.all([deliver(id), deliver(id), deliver(id)]);
    expect(results.map((item) => item.status).sort()).toEqual([200, 406, 406]);
    for (const failed of results.filter((item) => item.status !== 200)) {
      expect(failed.body.error.code).toBe('INVALID_LOAN_STATE_TRANSITION');
    }
    const recorded = await movements(assets);
    expect(recorded.map((item) => item.movement_type)).toEqual(['LOAN', 'LOAN']);
    expect(
      await scalar<number>(dataSource, `SELECT count(*)::int FROM document_request WHERE payload->>'entityId' = $1`, [id]),
    ).toBe(1);
    const loan = await detail(id);
    expect(loan.events.filter((event: { eventType: string }) => event.eventType === 'DELIVERED')).toHaveLength(1);
  });

  describe('ciclo completo con acta', () => {
    let loanId = '';
    let requestId = '';
    let documentId = '';
    const codes = [`LP-${tag}-D01`, `LP-${tag}-D02`, `LP-${tag}-D03`];
    const descriptions = ['PORTATIL LATITUDE PRUEBA', 'VIDEOBEAM EPSON PRUEBA', 'CAMARA DOCUMENTAL PRUEBA'];
    const assets: string[] = [];
    let expectedReturnDate = '';

    it('entrega: activos ON_LOAN con movimiento LOAN, préstamo ACTIVE y acta encolada; si la generación falla el préstamo queda intacto y visible', async () => {
      // Esta corrida no debe tener plantilla OCI-01-65 vigente todavía: la generación falla de verdad.
      expect(
        await scalar<number>(dataSource, 'SELECT count(*)::int FROM document_template_version WHERE format_key = $1', [FORMAT]),
      ).toBe(0);
      for (const [index, code] of codes.entries()) {
        assets.push(await asset(code, descriptions[index] ?? ''));
      }
      expectedReturnDate = addDays(bogotaDate(new Date()), 259);
      loanId = await requestLoan(assets, expectedReturnDate);
      await approve(loanId, 'jefeA').expect(200);

      const delivered = await deliver(loanId).expect(200);
      expectConforms('post', '/api/v1/loans/{id}/deliver', 200, delivered.body);
      const data = delivered.body.data;
      expect(data).toMatchObject({ status: 'ACTIVE', deliveredBy: users['director']?.userId, deliveryDocumentId: null });
      expect(data.deliveryAct).toMatchObject({ status: 'PENDING', formatKey: FORMAT, documentId: null, retryable: false });
      requestId = data.deliveryAct.requestId;
      expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
      const estimated = usageBetween(bogotaDate(new Date(data.deliveredAt)), expectedReturnDate);
      expect(data.estimatedUsage).toEqual(estimated);
      expect(data.actualUsage).toMatchObject({ years: 0, months: 0, days: 0 });

      for (const id of assets) {
        expect(await assetRow(id)).toMatchObject({ operational_status: 'ON_LOAN' });
      }
      const recorded = await movements(assets);
      expect(recorded.map((item) => [item.movement_type, item.to_operational_status])).toEqual(
        assets.map(() => ['LOAN', 'ON_LOAN']),
      );
      // AssetStateService no escribe asset_movement.loan_id: el vínculo va en metadata.
      expect(recorded.every((item) => item.loan_id === null && item.metadata['loanId'] === loanId)).toBe(true);

      const outbox = (
        (await dataSource.query('SELECT payload, requested_by FROM document_request WHERE id = $1', [requestId])) as Array<{
          payload: Record<string, unknown>;
          requested_by: string;
        }>
      )[0];
      expect(outbox?.payload).toEqual({
        formatKey: FORMAT,
        entityType: 'LOAN',
        entityId: loanId,
        costCenterId: centerA,
        responsiblePersonId: users['recibe']?.personId,
        assetIds: assets,
        movementIds: Object.fromEntries(recorded.map((item) => [item.asset_id, item.id])),
        signers: { ENTREGA: users['entrega']?.personId, AUDITA: users['audita']?.personId },
        fields: {
          fechaEntrega: longSpanishDate(bogotaDate(new Date(data.deliveredAt))),
          fechaEstimadaDevolucion: longSpanishDate(expectedReturnDate),
          tiempoUso: estimated?.text,
        },
      });
      expect(outbox?.requested_by).toBe(users['director']?.userId);

      await drain();
      const failed = await detail(loanId);
      expect(failed).toMatchObject({ status: 'ACTIVE', deliveryDocumentId: null });
      expect(failed.deliveryAct).toMatchObject({ status: 'FAILED', requestId, retryable: true, documentId: null });
      expect(failed.deliveryAct.error).toContain('No hay plantilla vigente para OCI-01-65');
      expect(failed.deliveryAct.attempts).toBeGreaterThanOrEqual(1);
      for (const id of assets) {
        expect(await assetRow(id)).toMatchObject({ operational_status: 'ON_LOAN' });
      }
      const active = await http().get('/api/v1/loans').query({ active: 'true', pageSize: 100 }).set(auth('director')).expect(200);
      expectConforms('get', '/api/v1/loans', 200, active.body);
      expect(active.body.data.items.map((item: { id: string }) => item.id)).toContain(loanId);
    });

    it('reintento: con plantilla vigente la solicitud reencolada genera el acta, el préstamo la enlaza y el acta nombra a los tres firmantes', async () => {
      templateId =
        (
          await engine.uploadTemplate(
            FORMAT,
            { buffer: await readFile(TEMPLATE), originalname: 'OCI-01-65-v2.docx' },
            { sgcVersion: '2', effectiveDate: bogotaDate(new Date()) },
            users['director']?.userId ?? null,
          )
        ).id ?? '';
      await http().post(`/api/v1/documents/requests/${requestId}/retry`).set(auth('director')).expect(200);
      await drain();

      const loan = await detail(loanId);
      expect(loan.deliveryAct).toMatchObject({ status: 'GENERATED', requestId, error: null, retryable: false });
      expect(loan.deliveryAct.number).toMatch(/^\d{4}-\d{4}$/);
      documentId = loan.deliveryAct.documentId;
      expect(loan.deliveryDocumentId).toBe(documentId);
      expect(loan.status).toBe('ACTIVE');
      const generatedEvent = loan.events.find((event: { eventType: string }) => event.eventType === 'DELIVERY_ACT_GENERATED');
      expect(generatedEvent?.payload).toMatchObject({ documentId, number: loan.deliveryAct.number });

      // Acta ↔ movimiento LOAN de cada activo.
      const links = (await dataSource.query(
        `SELECT da.asset_id, m.movement_type FROM document_asset da JOIN asset_movement m ON m.id = da.movement_id
         WHERE da.document_id = $1 ORDER BY da.asset_id`,
        [documentId],
      )) as Array<{ asset_id: string; movement_type: string }>;
      expect(links.map((item) => item.movement_type)).toEqual(['LOAN', 'LOAN', 'LOAN']);
      expect(links.map((item) => item.asset_id).sort()).toEqual([...assets].sort());

      const [row] = (await dataSource.query('SELECT docx_driver, docx_key, number FROM document WHERE id = $1', [documentId])) as Array<{
        docx_driver: 'project';
        docx_key: string;
        number: string;
      }>;
      const lines = paragraphs(await app.get(StorageService).getFrom(row?.docx_driver ?? 'project', row?.docx_key ?? ''));
      const text = lines.join('\n');
      const trimmed = lines.map((line) => line.trim());
      expect(text).not.toContain('{{');
      expect(text).not.toContain('}}');
      for (const who of ['entrega', 'recibe', 'audita']) {
        expect(text, who).toContain(users[who]?.fullName);
        expect(text, who).toContain(users[who]?.title);
      }
      expect(text).toContain(`C.C ${users['recibe']?.documentNumber}`);
      expect(text).toContain(`C.C ${users['entrega']?.documentNumber}`);
      const deliveredDay = bogotaDate(new Date(loan.deliveredAt));
      const usage = usageBetween(deliveredDay, expectedReturnDate);
      expect(text).toContain(`Tiempo de uso estimado:${usage?.text}`);
      expect(text).toContain(`Fecha de entrega: ${longSpanishDate(deliveredDay)}`);
      expect(text).toContain(longSpanishDate(expectedReturnDate));
      expect(text).toContain(`LA-${tag} CENTRO DE IDIOMAS PRUEBA`);
      expect(text).toContain(row?.number);
      expect(text).toMatch(/Total, elementos entregados:\s*3/);
      for (const [index, code] of codes.entries()) {
        expect(trimmed).toContain(`${code} - ${code} ${descriptions[index]}`);
      }
      // La sección de devolución sigue en blanco: el acta de devolución está bloqueada.
      expect(trimmed).toContain('Fecha de devolución:');
    });

    it('firma en orden Entrega → Recibe → Control Interno; al completarse el préstamo registra el evento y NO cambia de estado', async () => {
      const sign = (order: number, who: string) =>
        http().post(`/api/v1/documents/${documentId}/signatures/${order}`).set(auth(who)).send({ rubric });

      const document = (await http().get(`/api/v1/documents/${documentId}`).set(auth('director')).expect(200)).body.data;
      expect(document.signatures.map((item: { order: number; role: string; personId: string }) => [item.order, item.role, item.personId])).toEqual([
        [1, 'ENTREGA', users['entrega']?.personId],
        [2, 'RECIBE', users['recibe']?.personId],
        [3, 'AUDITA', users['audita']?.personId],
      ]);

      const early = await sign(2, 'recibe');
      expect([early.status, early.body.error.code]).toEqual([409, 'SIGNATURE_OUT_OF_ORDER']);
      await sign(1, 'entrega').expect(200);
      const auditEarly = await sign(3, 'audita');
      expect([auditEarly.status, auditEarly.body.error.code]).toEqual([409, 'SIGNATURE_OUT_OF_ORDER']);
      await sign(2, 'recibe').expect(200);
      expect((await detail(loanId)).deliveryAct.status).toBe('GENERATED');
      const done = await sign(3, 'audita').expect(200);
      expect(done.body.data.status).toBe('SIGNED');

      const loan = await detail(loanId);
      expect(loan.status).toBe('ACTIVE');
      expect(loan.deliveryAct).toMatchObject({ status: 'SIGNED', documentId, error: null });
      expect(loan.deliveryAct.signedAt).not.toBeNull();
      const signed = loan.events.find((event: { eventType: string }) => event.eventType === 'DELIVERY_ACT_SIGNED');
      expect(signed).toMatchObject({ performedBy: users['audita']?.userId });
      expect(signed?.payload.closedByPersonId).toBe(users['audita']?.personId);
      expect(signed?.payload.signers.map((item: { role: string; status: string }) => [item.role, item.status])).toEqual([
        ['ENTREGA', 'SIGNED'],
        ['RECIBE', 'SIGNED'],
        ['AUDITA', 'SIGNED'],
      ]);
    });

    it('devolución: fecha real y condición por activo; la recepción aplica RETURN en transacción con la fecha real', async () => {
      const loan = await detail(loanId);
      const deliveredAt = new Date(loan.deliveredAt);
      const [good, damaged, lost] = assets;

      const future = await http()
        .post(`/api/v1/loans/${loanId}/return`)
        .set(auth('director'))
        .send({ assetsReturned: [{ assetId: good, condition: 'GOOD', returnedAt: new Date(Date.now() + 86_400_000).toISOString() }] });
      expect([future.status, future.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);
      const before = await http()
        .post(`/api/v1/loans/${loanId}/return`)
        .set(auth('director'))
        .send({ assetsReturned: [{ assetId: good, condition: 'GOOD', returnedAt: new Date(deliveredAt.getTime() - 60_000).toISOString() }] });
      expect([before.status, before.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);
      const badCondition = await http()
        .post(`/api/v1/loans/${loanId}/return`)
        .set(auth('director'))
        .send({ assetsReturned: [{ assetId: good, condition: 'BROKEN' }] });
      expect([badCondition.status, badCondition.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);
      expect((await detail(loanId)).status).toBe('ACTIVE');

      const goodAt = new Date(deliveredAt.getTime() + 1);
      const damagedAt = new Date(deliveredAt.getTime() + 2);
      const started = await http()
        .post(`/api/v1/loans/${loanId}/return`)
        .set(auth('director'))
        .send({
          notes: 'Devuelto en la oficina del centro',
          assetsReturned: [
            { assetId: good, condition: 'GOOD', returnedAt: goodAt.toISOString() },
            { assetId: damaged, condition: 'DAMAGED', returnedAt: damagedAt.toISOString() },
            { assetId: lost, condition: 'LOST' },
          ],
        })
        .expect(200);
      expectConforms('post', '/api/v1/loans/{id}/return', 200, started.body);
      expect(started.body.data.status).toBe('PENDING_RECEPTION');
      const returnedItems: Array<{ assetId: string; returnCondition: string; returnedAt: string }> = started.body.data.items;
      const byAsset = new Map(returnedItems.map((item) => [item.assetId, item]));
      expect(byAsset.get(good ?? '')).toMatchObject({ returnCondition: 'GOOD', returnedAt: goodAt.toISOString() });
      expect(byAsset.get(damaged ?? '')).toMatchObject({ returnCondition: 'DAMAGED', returnedAt: damagedAt.toISOString() });
      // Mientras no se recibe, siguen prestados.
      expect(await assetRow(good ?? '')).toMatchObject({ operational_status: 'ON_LOAN' });

      const received = await http().post(`/api/v1/loans/${loanId}/receive-return`).set(auth('director')).send({}).expect(200);
      expectConforms('post', '/api/v1/loans/{id}/receive-return', 200, received.body);
      const data = received.body.data;
      // LOST cuenta como no devuelto: mapeo heredado sin cambios.
      expect(data.status).toBe('PARTIALLY_RETURNED');
      const lostItem = byAsset.get(lost ?? '');
      expect(lostItem?.returnCondition).toBe('LOST');
      const lostReturnedAt = new Date(lostItem?.returnedAt ?? '');
      expect(new Date(data.actualReturnDate).getTime()).toBe(Math.max(damagedAt.getTime(), lostReturnedAt.getTime()));
      expect(data.actualUsage).toEqual(usageBetween(bogotaDate(deliveredAt), bogotaDate(new Date(data.actualReturnDate))));

      expect(await assetRow(good ?? '')).toEqual({ operational_status: 'IN_USE', physical_condition: 'GOOD' });
      expect(await assetRow(damaged ?? '')).toEqual({ operational_status: 'IN_USE', physical_condition: 'FAIR' });
      expect(await assetRow(lost ?? '')).toEqual({ operational_status: 'LOST', physical_condition: 'GOOD' });
      const returns = (await movements(assets)).filter((item) => item.movement_type === 'RETURN');
      expect(returns).toHaveLength(3);
      const executed = new Map(returns.map((item) => [item.asset_id, new Date(item.executed_at).getTime()]));
      expect(executed.get(good ?? '')).toBe(goodAt.getTime());
      expect(executed.get(damaged ?? '')).toBe(damagedAt.getTime());
      expect(returns.every((item) => item.metadata['loanId'] === loanId)).toBe(true);
      expect(data.events.map((event: { eventType: string }) => event.eventType)).toEqual([
        'REQUESTED',
        'APPROVED',
        'DELIVERED',
        'DELIVERY_ACT_GENERATED',
        'DELIVERY_ACT_SIGNED',
        'RETURN_STARTED',
        'RECEIVED',
      ]);
      // No se generó acta de devolución.
      expect(
        await scalar<number>(dataSource, `SELECT count(*)::int FROM document WHERE entity_type = 'LOAN' AND entity_id = $1`, [loanId]),
      ).toBe(1);
    });
  });

  it('vencidos en SQL: ACTIVE vencidos aunque el job no los haya marcado, OVERDUE, días de atraso; el job solo marca ACTIVE vencidos', async () => {
    const today = bogotaDate(new Date());
    const insert = (status: string, expected: string) =>
      scalar<string>(
        dataSource,
        `INSERT INTO asset_loan (source_cost_center_id, target_cost_center_id, target_responsible_id, expected_return_date,
           requested_by, status, purpose, delivered_at)
         VALUES ($1, $2, $3, $4, $5, $6::loan_status, 'Vencidos', NOW() - interval '40 days') RETURNING id`,
        [centerA, centerB, users['recibe']?.personId, expected, users['solicitante']?.userId, status],
      );
    const activeLate = await insert('ACTIVE', addDays(today, -5));
    const overdueLate = await insert('OVERDUE', addDays(today, -12));
    const activeOnTime = await insert('ACTIVE', today);
    const returnedLate = await insert('RETURNED', addDays(today, -30));
    loanIds.push(activeLate, overdueLate, activeOnTime, returnedLate);

    const response = await http().get('/api/v1/loans/overdue').set(auth('director')).expect(200);
    expectConforms('get', '/api/v1/loans/overdue', 200, response.body);
    const mine = (response.body.data as Array<{ id: string; daysOverdue: number; status: string }>).filter((item) =>
      [activeLate, overdueLate, activeOnTime, returnedLate].includes(item.id),
    );
    expect(mine.map((item) => [item.id, item.status, item.daysOverdue])).toEqual([
      [overdueLate, 'OVERDUE', 12],
      [activeLate, 'ACTIVE', 5],
    ]);
    const listed = await http().get('/api/v1/loans').query({ overdue: 'true', pageSize: 100 }).set(auth('director')).expect(200);
    const listedIds = listed.body.data.items.map((item: { id: string }) => item.id);
    expect(listedIds).toEqual(expect.arrayContaining([activeLate, overdueLate]));
    expect(listedIds).not.toContain(activeOnTime);
    expect(listedIds).not.toContain(returnedLate);
    expect((await detail(activeOnTime)).daysOverdue).toBe(0);
    expect((await detail(returnedLate)).daysOverdue).toBeNull();

    const invalid = await http().get('/api/v1/loans').query({ status: 'NOPE' }).set(auth('director'));
    expect([invalid.status, invalid.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);

    await app.get(LoansService).markOverdue();
    const statuses = (await dataSource.query('SELECT id, status FROM asset_loan WHERE id = ANY($1)', [
      [activeLate, overdueLate, activeOnTime, returnedLate],
    ])) as Array<{ id: string; status: string }>;
    expect(Object.fromEntries(statuses.map((item) => [item.id, item.status]))).toEqual({
      [activeLate]: 'OVERDUE',
      [overdueLate]: 'OVERDUE',
      [activeOnTime]: 'ACTIVE',
      [returnedLate]: 'RETURNED',
    });
  });
});
