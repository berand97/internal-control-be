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
  let centerC: string;
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
    await user('recibe2', 'ReceptoraDos', 'DOCENTE LABORATORIO', []);
    await user('nadie', 'SinPermisos', 'Auxiliar', []);
    centerC = await scalar<string>(
      dataSource,
      `INSERT INTO cost_center (external_code, name) VALUES ($1, 'CENTRO AJENO PRUEBA') RETURNING id`,
      [`LC-${tag}`],
    );
    await user('jefeC', 'JefeAjeno', 'Jefe', [{ role: 'DEPARTMENT_HEAD', scopeType: 'COST_CENTER', scopeId: centerC }]);
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
    await dataSource.query('DELETE FROM signature_signing_link WHERE document_id = ANY($1)', [ids]);
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

    it('entrega: activos ON_LOAN con movimiento LOAN, préstamo PENDING_SIGNATURES y acta encolada; responsable y centro no cambian; si la generación falla el préstamo queda intacto y visible', async () => {
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
      expect(data).toMatchObject({ status: 'PENDING_SIGNATURES', deliveredBy: users['director']?.userId, deliveryDocumentId: null });
      // El préstamo es a la dependencia: el activo conserva su centro de costo (origen) y su responsable.
      const holders = (await dataSource.query(
        'SELECT current_cost_center_id, current_responsible_id FROM asset WHERE id = ANY($1)',
        [assets],
      )) as Array<{ current_cost_center_id: string; current_responsible_id: string | null }>;
      expect(holders.every((item) => item.current_cost_center_id === centerA && item.current_responsible_id === null)).toBe(true);
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
      expect(failed).toMatchObject({ status: 'PENDING_SIGNATURES', deliveryDocumentId: null });
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
      expect(loan.status).toBe('PENDING_SIGNATURES');
      expect(loan.deliveryAct).toMatchObject({ regenerable: false, previous: [] });
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
      // Personas con tipo CC: el acta imprime la abreviatura del catálogo.
      expect(text).toContain(`C.C. ${users['recibe']?.documentNumber}`);
      expect(text).toContain(`C.C. ${users['entrega']?.documentNumber}`);
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

    it('firma en orden Entrega → Recibe → Control Interno; la última firma pasa el préstamo a ACTIVE en la misma transacción', async () => {
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
      const beforeLast = await detail(loanId);
      expect(beforeLast.deliveryAct.status).toBe('GENERATED');
      expect(beforeLast.status).toBe('PENDING_SIGNATURES');
      const done = await sign(3, 'audita').expect(200);
      expect(done.body.data.status).toBe('SIGNED');

      const loan = await detail(loanId);
      expect(loan.status).toBe('ACTIVE');
      expect(loan.deliveryAct).toMatchObject({ status: 'SIGNED', documentId, error: null, regenerable: false });
      expect(loan.deliveryAct.signedAt).not.toBeNull();
      const signed = loan.events.find((event: { eventType: string }) => event.eventType === 'DELIVERY_ACT_SIGNED');
      expect(signed).toMatchObject({ performedBy: users['audita']?.userId });
      expect(signed?.payload.closedByPersonId).toBe(users['audita']?.personId);
      expect(signed?.payload.activated).toBe(true);
      // El responsable del activo sigue sin cambiar tras la activación.
      expect(
        await scalar<number>(dataSource, 'SELECT count(*)::int FROM asset WHERE id = ANY($1) AND current_responsible_id IS NOT NULL', [assets]),
      ).toBe(0);
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
      // Todos resueltos y uno perdido: cerrado con pérdidas (el activo perdido queda LOST, mapeo heredado).
      expect(data.status).toBe('CLOSED_WITH_LOSSES');
      expect(data.items.every((item: { outstanding: boolean; receivedAt: string | null }) => !item.outstanding && item.receivedAt)).toBe(true);
      // Acta de devolución: formato institucional pendiente; la devolución quedó registrada igual.
      expect(data.returnActFormat).toMatchObject({ formatKey: 'LOAN_RETURN', sgcCode: null, ready: false });
      expect(data.returnActFormat.pendingDecisions.length).toBeGreaterThanOrEqual(2);
      expect(data.returnActs).toHaveLength(1);
      expect(data.returnActs[0]).toMatchObject({ status: 'PENDING_FORMAT', requestId: null, documentId: null });
      expect([...data.returnActs[0].assetIds].sort()).toEqual([...assets].sort());
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
      // No se generó acta de devolución (formato pendiente) ni quedó solicitud en el outbox.
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
    const unsignedLate = await insert('PENDING_SIGNATURES', addDays(today, -3));
    loanIds.push(unsignedLate);
    const overdueLate = await insert('OVERDUE', addDays(today, -12));
    const activeOnTime = await insert('ACTIVE', today);
    const returnedLate = await insert('RETURNED', addDays(today, -30));
    loanIds.push(activeLate, overdueLate, activeOnTime, returnedLate);

    const response = await http().get('/api/v1/loans/overdue').set(auth('director')).expect(200);
    expectConforms('get', '/api/v1/loans/overdue', 200, response.body);
    const mine = (response.body.data as Array<{ id: string; daysOverdue: number; status: string }>).filter((item) =>
      [activeLate, overdueLate, activeOnTime, returnedLate].includes(item.id),
    );
    const unsigned = (response.body.data as Array<{ id: string; daysOverdue: number; status: string }>).find((item) => item.id === unsignedLate);
    // Entregado sin firmas completas y vencido: cuenta como vencido (los activos salieron).
    expect(unsigned).toMatchObject({ status: 'PENDING_SIGNATURES', daysOverdue: 3 });
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
    // El job no toca PENDING_SIGNATURES: pasa a ACTIVE solo con la firma.
    expect(await scalar<string>(dataSource, 'SELECT status::text FROM asset_loan WHERE id = $1', [unsignedLate])).toBe('PENDING_SIGNATURES');
  });
  describe('decisiones de Control Interno y defectos corregidos', () => {
    /** Filas de audit_log del préstamo con esa acción; ninguna lleva números de documento de los usuarios. */
    const loanAudits = async (loanId: string, action: string) => {
      const rows = (await dataSource.query(
        `SELECT entity_type, performed_by, changes FROM audit_log WHERE entity_id = $1 AND action = $2 ORDER BY id`,
        [loanId, action],
      )) as Array<{ entity_type: string; performed_by: string; changes: Record<string, unknown> | null }>;
      for (const user of Object.values(users)) {
        expect(JSON.stringify(rows)).not.toContain(user.documentNumber);
      }
      return rows;
    };

    const sign = (documentId: string, order: number, who: string) =>
      http().post(`/api/v1/documents/${documentId}/signatures/${order}`).set(auth(who)).send({ rubric });

    /** Préstamo entregado con su acta generada (plantilla OCI-01-65 ya vigente desde el ciclo completo). */
    const deliveredWithAct = async (codes: string[]) => {
      const ids: string[] = [];
      for (const code of codes) {
        ids.push(await asset(code, `EQUIPO ${code}`));
      }
      const id = await requestLoan(ids, addDays(bogotaDate(new Date()), 30));
      await approve(id, 'director').expect(200);
      await deliver(id).expect(200);
      await drain();
      const loan = await detail(id);
      expect(loan.deliveryAct.status).toBe('GENERATED');
      return { id, assets: ids, documentId: loan.deliveryAct.documentId as string, number: loan.deliveryAct.number as string };
    };

    /** Atajo de prueba: préstamo entregado y ACTIVE sin pasar por las firmas (lo que se prueba es otra cosa). */
    const activeLoan = async (codes: string[]) => {
      const ids: string[] = [];
      for (const code of codes) {
        ids.push(await asset(code, `EQUIPO ${code}`));
      }
      const id = await requestLoan(ids, addDays(bogotaDate(new Date()), 30));
      await approve(id, 'director').expect(200);
      await deliver(id).expect(200);
      await dataSource.query(`UPDATE asset_loan SET status = 'ACTIVE' WHERE id = $1`, [id]);
      return { id, assets: ids };
    };

    it('lectura por alcance: global ve todo; loan:read:org_unit ve origen o destino (en la consulta); fuera de alcance 404 idéntico', async () => {
      const id = await requestLoan([await asset(`LP-${tag}-S01`, 'ESCANER ALCANCE')], addDays(bogotaDate(new Date()), 10));
      const get = (who: string, loanId = id) => http().get(`/api/v1/loans/${loanId}`).set(auth(who));
      const listIds = async (who: string) =>
        ((await http().get('/api/v1/loans').query({ pageSize: 100 }).set(auth(who)).expect(200)).body.data.items as Array<{ id: string }>).map(
          (item) => item.id,
        );

      // Jefe del origen (el que aprueba) y jefe del destino (la dependencia que recibe) ven el préstamo.
      for (const who of ['jefeA', 'jefeB', 'custodio']) {
        const response = await get(who).expect(200);
        expectConforms('get', '/api/v1/loans/{id}', 200, response.body);
        expect(await listIds(who)).toContain(id);
      }
      // Jefe de otro centro: 404 idéntico a inexistente, y no aparece en la lista ni en vencidos.
      const outside = await get('jefeC');
      const missing = await get('jefeC', randomUUID());
      expect(outside.status).toBe(404);
      expect(outside.body).toEqual(missing.body);
      const others = await listIds('jefeC');
      expect(others).not.toContain(id);
      expect(others.filter((loanId) => loanIds.includes(loanId))).toEqual([]);
      const overdue = await http().get('/api/v1/loans/overdue').set(auth('jefeC')).expect(200);
      expect(overdue.body.data).toEqual([]);
      // Sin permiso: 403; rol acotado asignado GLOBAL (sin centros): 403 SCOPE_NO_COST_CENTER.
      expect((await get('nadie')).body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect((await get('nadie')).status).toBe(403);
      const global = await http().get('/api/v1/loans').set(auth('jefeGlobal'));
      expect([global.status, global.body.error.code]).toEqual([403, 'SCOPE_NO_COST_CENTER']);
      // El jefe del destino lee pero no aprueba (404, como antes).
      expect((await approve(id, 'jefeB')).status).toBe(404);
    });

    it('solicitud concurrente: la disponibilidad se valida dentro de la transacción; el mismo activo no entra en dos solicitudes', async () => {
      const shared = await asset(`LP-${tag}-K01`, 'PROYECTOR CONCURRENTE');
      const send = () =>
        http()
          .post('/api/v1/loans')
          .set(auth('solicitante'))
          .send({
            assets: [shared],
            targetCostCenterId: centerB,
            expectedReturnDate: addDays(bogotaDate(new Date()), 20),
            justification: 'Solicitud concurrente del mismo activo para prueba',
            contactPerson: users['recibe']?.personId,
          });
      const results = await Promise.all([send(), send(), send()]);
      expect(results.map((item) => item.status).sort()).toEqual([201, 406, 406]);
      for (const failed of results.filter((item) => item.status !== 201)) {
        expect(failed.body.error.code).toBe('ASSET_ALREADY_LOANED');
      }
      loanIds.push(...results.filter((item) => item.status === 201).map((item) => item.body.data.id as string));
      expect(await scalar<number>(dataSource, 'SELECT count(*)::int FROM asset_loan_item WHERE asset_id = $1', [shared])).toBe(1);
      // Secuencial también: una solicitud abierta reserva el activo.
      expect((await send()).body.error.code).toBe('ASSET_ALREADY_LOANED');
    });

    it('acta rechazada: el préstamo sigue PENDING_SIGNATURES; nueva acta con nuevo consecutivo y firmantes corregidos; al firmarla queda ACTIVE', async () => {
      const loan = await deliveredWithAct([`LP-${tag}-R01`]);
      const notRejected = await http()
        .post(`/api/v1/loans/${loan.id}/delivery-act/regenerate`)
        .set(auth('director'))
        .send({ deliveredByPersonId: users['entrega']?.personId, controlInternoPersonId: users['audita']?.personId, reason: 'Corrección' });
      expect([notRejected.status, notRejected.body.error.code]).toEqual([409, 'LOAN_DELIVERY_ACT_NOT_REJECTED']);

      await http()
        .post(`/api/v1/documents/${loan.documentId}/signatures/1/reject`)
        .set(auth('entrega'))
        .send({ reason: 'El acta nombra mal a quien recibe' })
        .expect(200);
      const rejected = await detail(loan.id);
      expect(rejected.status).toBe('PENDING_SIGNATURES');
      expect(rejected.deliveryAct).toMatchObject({ status: 'REJECTED', documentId: loan.documentId, regenerable: true });
      expect(rejected.events.map((event: { eventType: string }) => event.eventType)).toContain('DELIVERY_ACT_REJECTED');

      const regenerate = (who: string) =>
        http()
          .post(`/api/v1/loans/${loan.id}/delivery-act/regenerate`)
          .set(auth(who))
          .send({
            deliveredByPersonId: users['entrega']?.personId,
            controlInternoPersonId: users['audita']?.personId,
            contactPersonId: users['recibe2']?.personId,
            reason: 'Se corrige la persona que recibe',
          });
      expect((await regenerate('jefeA')).status).toBe(403);
      const regenerated = await regenerate('director').expect(200);
      expectConforms('post', '/api/v1/loans/{id}/delivery-act/regenerate', 200, regenerated.body);
      expect(regenerated.body.data).toMatchObject({ status: 'PENDING_SIGNATURES', contactPersonId: users['recibe2']?.personId });
      expect(regenerated.body.data.deliveryAct).toMatchObject({ status: 'PENDING', documentId: null, regenerable: false });
      // Auditoría con su propia acción (antes LOAN_DELIVERED + changes.kind), en la transacción de la regeneración.
      expect(await loanAudits(loan.id, 'LOAN_ACT_REGENERATED')).toEqual([
        {
          entity_type: 'LOAN',
          performed_by: users['director']?.userId,
          changes: {
            documentRequestId: expect.any(String),
            previousDocumentId: loan.documentId,
            reason: 'Se corrige la persona que recibe',
          },
        },
      ]);
      expect(
        (await loanAudits(loan.id, 'LOAN_DELIVERED')).filter((row) => row.changes !== null && 'kind' in row.changes),
      ).toEqual([]);
      // La movida del enlace movimiento ↔ acta: la rechazada ya no lo tiene.
      expect(
        await scalar<number>(dataSource, 'SELECT count(*)::int FROM document_asset WHERE document_id = $1 AND movement_id IS NOT NULL', [
          loan.documentId,
        ]),
      ).toBe(0);

      await drain();
      const renewed = await detail(loan.id);
      const newDocumentId = renewed.deliveryAct.documentId as string;
      expect(renewed.deliveryAct.status).toBe('GENERATED');
      expect(newDocumentId).not.toBe(loan.documentId);
      expect(renewed.deliveryAct.number).not.toBe(loan.number);
      expect(renewed.deliveryDocumentId).toBe(newDocumentId);
      expect(renewed.deliveryAct.previous).toEqual([
        expect.objectContaining({ documentId: loan.documentId, number: loan.number, status: 'REJECTED' }),
      ]);
      const links = (await dataSource.query(
        `SELECT m.movement_type FROM document_asset da JOIN asset_movement m ON m.id = da.movement_id WHERE da.document_id = $1`,
        [newDocumentId],
      )) as Array<{ movement_type: string }>;
      expect(links.map((item) => item.movement_type)).toEqual(['LOAN']);
      const signers = (await dataSource.query(
        'SELECT role, signer_person_id FROM document_signature WHERE document_id = $1 ORDER BY sign_order',
        [newDocumentId],
      )) as Array<{ role: string; signer_person_id: string }>;
      expect(signers.map((item) => [item.role, item.signer_person_id])).toEqual([
        ['ENTREGA', users['entrega']?.personId],
        ['RECIBE', users['recibe2']?.personId],
        ['AUDITA', users['audita']?.personId],
      ]);

      await sign(newDocumentId, 1, 'entrega').expect(200);
      await sign(newDocumentId, 2, 'recibe2').expect(200);
      await sign(newDocumentId, 3, 'audita').expect(200);
      const active = await detail(loan.id);
      expect(active.status).toBe('ACTIVE');
      expect(active.deliveryAct).toMatchObject({ status: 'SIGNED', documentId: newDocumentId });
      expect(active.events.map((event: { eventType: string }) => event.eventType)).toEqual([
        'REQUESTED',
        'APPROVED',
        'DELIVERED',
        'DELIVERY_ACT_GENERATED',
        'DELIVERY_ACT_REJECTED',
        'DELIVERY_ACT_REGENERATED',
        'DELIVERY_ACT_GENERATED',
        'DELIVERY_ACT_SIGNED',
      ]);

      // Con el acta firmada no se deshace la entrega.
      const undo = await http().post(`/api/v1/loans/${loan.id}/undo-delivery`).set(auth('director')).send({ reason: 'Ya no se necesita' });
      expect([undo.status, undo.body.error.code]).toEqual([409, 'DOCUMENT_ALREADY_SIGNED']);
      expect((await detail(loan.id)).status).toBe('ACTIVE');
    });

    it('deshacer la entrega: anula el acta pendiente, revierte los activos con movimiento RETURN trazable y cancela el préstamo', async () => {
      const loan = await deliveredWithAct([`LP-${tag}-U01`, `LP-${tag}-U02`]);
      const short = await http().post(`/api/v1/loans/${loan.id}/undo-delivery`).set(auth('director')).send({ reason: 'no' });
      expect(short.status).toBe(400);
      expect((await http().post(`/api/v1/loans/${loan.id}/undo-delivery`).set(auth('jefeA')).send({ reason: 'No sigue el préstamo' })).status).toBe(403);

      const undone = await http()
        .post(`/api/v1/loans/${loan.id}/undo-delivery`)
        .set(auth('director'))
        .send({ reason: 'La dependencia de destino desistió del préstamo' })
        .expect(200);
      expectConforms('post', '/api/v1/loans/{id}/undo-delivery', 200, undone.body);
      expect(undone.body.data.status).toBe('CANCELLED');
      expect(undone.body.data.deliveryAct).toMatchObject({ status: 'VOIDED', documentId: loan.documentId });
      expect(undone.body.data.items.every((item: { outstanding: boolean }) => !item.outstanding)).toBe(true);
      const [document] = (await dataSource.query('SELECT status, void_reason FROM document WHERE id = $1', [loan.documentId])) as Array<{
        status: string;
        void_reason: string;
      }>;
      expect(document).toEqual({ status: 'VOIDED', void_reason: 'La dependencia de destino desistió del préstamo' });
      for (const assetId of loan.assets) {
        expect(await assetRow(assetId)).toMatchObject({ operational_status: 'IN_USE' });
      }
      const recorded = await movements(loan.assets);
      expect(recorded.map((item) => item.movement_type).sort()).toEqual(['LOAN', 'LOAN', 'RETURN', 'RETURN']);
      expect(
        recorded.filter((item) => item.movement_type === 'RETURN').every((item) => item.metadata['undoDelivery'] === true && item.metadata['loanId'] === loan.id),
      ).toBe(true);
      expect(undone.body.data.events.at(-1)).toMatchObject({ eventType: 'DELIVERY_UNDONE' });
      expect(await loanAudits(loan.id, 'LOAN_DELIVERY_UNDONE')).toEqual([
        {
          entity_type: 'LOAN',
          performed_by: users['director']?.userId,
          changes: { reason: 'La dependencia de destino desistió del préstamo', voidedDocumentIds: [loan.documentId] },
        },
      ]);
      expect(await loanAudits(loan.id, 'LOAN_RETURNED')).toEqual([]);
      // Nadie firma el acta anulada; deshacer dos veces no es una transición válida.
      expect((await sign(loan.documentId, 1, 'entrega')).status).toBe(406);
      const again = await http().post(`/api/v1/loans/${loan.id}/undo-delivery`).set(auth('director')).send({ reason: 'Otra vez' });
      expect([again.status, again.body.error.code]).toEqual([406, 'INVALID_LOAN_STATE_TRANSITION']);
      // Los activos quedan libres para otra solicitud.
      loanIds.push(await requestLoan(loan.assets, addDays(bogotaDate(new Date()), 5)));
    });

    it('préstamo parcialmente devuelto: los pendientes se devuelven después o se declaran perdidos hasta cerrar el préstamo', async () => {
      const first = await activeLoan([`LP-${tag}-P01`, `LP-${tag}-P02`]);
      const [kept, later] = first.assets;
      const returnAssets = (id: string, list: Array<{ assetId: string; condition: string }>) =>
        http().post(`/api/v1/loans/${id}/return`).set(auth('director')).send({ assetsReturned: list });
      const receive = (id: string) => http().post(`/api/v1/loans/${id}/receive-return`).set(auth('director')).send({});

      await returnAssets(first.id, [{ assetId: kept ?? '', condition: 'GOOD' }]).expect(200);
      const partial = (await receive(first.id).expect(200)).body.data;
      expect(partial.status).toBe('PARTIALLY_RETURNED');
      const byAsset = new Map((partial.items as Array<{ assetId: string; outstanding: boolean }>).map((item) => [item.assetId, item]));
      expect(byAsset.get(kept ?? '')?.outstanding).toBe(false);
      expect(byAsset.get(later ?? '')?.outstanding).toBe(true);
      expect(await assetRow(later ?? '')).toMatchObject({ operational_status: 'ON_LOAN' });
      // Sigue con activos fuera: aparece en active=true.
      const active = await http().get('/api/v1/loans').query({ active: 'true', pageSize: 100 }).set(auth('director')).expect(200);
      expect(active.body.data.items.map((item: { id: string }) => item.id)).toContain(first.id);
      // Un activo ya recibido no se vuelve a registrar.
      expect((await returnAssets(first.id, [{ assetId: kept ?? '', condition: 'GOOD' }])).status).toBe(400);

      await returnAssets(first.id, [{ assetId: later ?? '', condition: 'GOOD' }]).expect(200);
      const closed = (await receive(first.id).expect(200)).body.data;
      expect(closed.status).toBe('RETURNED');
      expect(await assetRow(later ?? '')).toMatchObject({ operational_status: 'IN_USE' });
      expect(closed.returnActs.map((act: { status: string }) => act.status)).toEqual(['PENDING_FORMAT', 'PENDING_FORMAT']);
      expect(closed.returnActs.map((act: { assetIds: string[] }) => act.assetIds)).toEqual([[kept], [later]]);
      expect((await returnAssets(first.id, [{ assetId: later ?? '', condition: 'GOOD' }])).body.error.code).toBe(
        'INVALID_LOAN_STATE_TRANSITION',
      );

      // Otro préstamo: el pendiente se declara perdido → CLOSED_WITH_LOSSES, el activo queda LOST.
      const second = await activeLoan([`LP-${tag}-P03`, `LP-${tag}-P04`]);
      const [ok, gone] = second.assets;
      await returnAssets(second.id, [{ assetId: ok ?? '', condition: 'DAMAGED' }]).expect(200);
      expect((await receive(second.id).expect(200)).body.data.status).toBe('PARTIALLY_RETURNED');
      await returnAssets(second.id, [{ assetId: gone ?? '', condition: 'LOST' }]).expect(200);
      const lost = (await receive(second.id).expect(200)).body.data;
      expect(lost.status).toBe('CLOSED_WITH_LOSSES');
      expect(await assetRow(gone ?? '')).toMatchObject({ operational_status: 'LOST' });
      expect(await assetRow(ok ?? '')).toMatchObject({ operational_status: 'IN_USE', physical_condition: 'FAIR' });
      const returns = (await movements(second.assets)).filter((item) => item.movement_type === 'RETURN');
      expect(returns.map((item) => item.metadata['returnCondition']).sort()).toEqual(['DAMAGED', 'LOST']);
    });

    it('extensión: el solicitante la pide; la aprueba quien puede aprobar el préstamo (origen o global), nunca el solicitante', async () => {
      const loan = await activeLoan([`LP-${tag}-E01`]);
      const current = (await detail(loan.id)).expectedReturnDate as string;
      const newDate = addDays(current, 15);
      const ask = (who: string, date = newDate) =>
        http().post(`/api/v1/loans/${loan.id}/extend`).set(auth(who)).send({ expectedReturnDate: date, reason: 'Se alarga el semestre' });

      // Aprobar sin pedido: 409.
      const early = await http().post(`/api/v1/loans/${loan.id}/extension/approve`).set(auth('jefeA')).send({});
      expect([early.status, early.body.error.code]).toEqual([409, 'LOAN_NO_PENDING_EXTENSION']);
      // Solo el solicitante pide (el director tiene loan:request:own pero no pidió el préstamo).
      const notRequester = await ask('director');
      expect([notRequester.status, notRequester.body.error.code]).toEqual([403, 'LOAN_EXTENSION_NOT_REQUESTER']);
      expect((await ask('solicitante', current)).status).toBe(400);

      const asked = await ask('solicitante').expect(200);
      expectConforms('post', '/api/v1/loans/{id}/extend', 200, asked.body);
      expect(asked.body.data).toMatchObject({ expectedReturnDate: current, extensionRequestedDate: newDate });

      // El solicitante (que además tiene loan:approve:global) no aprueba su propia extensión.
      const own = await http().post(`/api/v1/loans/${loan.id}/extension/approve`).set(auth('solicitante')).send({});
      expect([own.status, own.body.error.code]).toEqual([403, 'LOAN_SOD_VIOLATION']);
      // Jefe del destino: no aprueba (404 como en la aprobación del préstamo); sin permiso: 403.
      expect((await http().post(`/api/v1/loans/${loan.id}/extension/approve`).set(auth('jefeB')).send({})).status).toBe(404);
      expect((await http().post(`/api/v1/loans/${loan.id}/extension/approve`).set(auth('custodio')).send({})).status).toBe(403);

      const approved = await http().post(`/api/v1/loans/${loan.id}/extension/approve`).set(auth('jefeA')).send({}).expect(200);
      expectConforms('post', '/api/v1/loans/{id}/extension/approve', 200, approved.body);
      expect(approved.body.data).toMatchObject({ expectedReturnDate: newDate, extensionRequestedDate: null, status: 'ACTIVE' });
      expect(approved.body.data.events.at(-1)).toMatchObject({
        eventType: 'EXTENDED',
        performedBy: users['jefeA']?.userId,
        payload: { expectedReturnDate: newDate, previousExpectedReturnDate: current },
      });

      // Rechazo de un segundo pedido.
      await ask('solicitante', addDays(newDate, 5)).expect(200);
      const rejected = await http()
        .post(`/api/v1/loans/${loan.id}/extension/reject`)
        .set(auth('director'))
        .send({ reason: 'No hay más plazo' })
        .expect(200);
      expectConforms('post', '/api/v1/loans/{id}/extension/reject', 200, rejected.body);
      expect(rejected.body.data).toMatchObject({ expectedReturnDate: newDate, extensionRequestedDate: null });
      expect(rejected.body.data.events.at(-1)).toMatchObject({ eventType: 'EXTENSION_REJECTED' });
      expect(await loanAudits(loan.id, 'LOAN_EXT_REJECTED')).toEqual([
        { entity_type: 'LOAN', performed_by: users['director']?.userId, changes: { reason: 'No hay más plazo' } },
      ]);
      expect((await loanAudits(loan.id, 'LOAN_EXTENDED')).filter((row) => row.changes !== null && 'kind' in row.changes)).toEqual([]);

      // OVERDUE con la nueva fecha no vencida vuelve a ACTIVE.
      await dataSource.query(`UPDATE asset_loan SET status = 'OVERDUE', expected_return_date = $2 WHERE id = $1`, [
        loan.id,
        addDays(bogotaDate(new Date()), -2),
      ]);
      await ask('solicitante', addDays(bogotaDate(new Date()), 10)).expect(200);
      const reopened = await http().post(`/api/v1/loans/${loan.id}/extension/approve`).set(auth('director')).send({}).expect(200);
      expect(reopened.body.data.status).toBe('ACTIVE');
    });

    it('acta de devolución: el formato existe en el catálogo pero el motor se niega a generarlo sin código SGC ni firmantes', async () => {
      const formats = (await http().get('/api/v1/documents/formats').set(auth('director')).expect(200)).body.data as Array<{
        key: string;
        sgcCode: string | null;
        version: string | null;
        ready: boolean;
        signers: unknown[];
        pendingDecisions: string[];
      }>;
      expect(formats.find((format) => format.key === 'LOAN_RETURN')).toMatchObject({ sgcCode: null, version: null, ready: false, signers: [] });
      expect(formats.find((format) => format.key === 'OCI-01-65')).toMatchObject({ sgcCode: 'OCI-01-65', ready: true });

      const generate = await http()
        .post('/api/v1/documents')
        .set(auth('director'))
        .send({ formatKey: 'LOAN_RETURN', responsiblePersonId: users['recibe']?.personId });
      expect([generate.status, generate.body.error.code]).toEqual([409, 'DOCUMENT_FORMAT_NOT_READY']);
      expect(generate.body.error.message).toContain('sin código SGC');
      await expect(
        dataSource.transaction((manager) => engine.enqueue(manager, { formatKey: 'LOAN_RETURN', entityType: 'LOAN', entityId: randomUUID() }, null)),
      ).rejects.toMatchObject({ code: 'DOCUMENT_FORMAT_NOT_READY' });
      await expect(
        engine.uploadTemplate('LOAN_RETURN', { buffer: await readFile(TEMPLATE), originalname: 'x.docx' }, { sgcVersion: '1', effectiveDate: '2026-01-01' }, null),
      ).rejects.toMatchObject({ code: 'DOCUMENT_FORMAT_NOT_READY' });
      expect(await scalar<number>(dataSource, `SELECT count(*)::int FROM document_request WHERE format_key = 'LOAN_RETURN'`)).toBe(0);
    });
  });
});
