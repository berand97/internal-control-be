import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import QRCode from 'qrcode';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { createAppValidationPipe } from '../../src/common/pipes/app-validation.pipe.js';
import { TokenService } from '../../src/modules/auth/services/token.service.js';
import { PDF_CONVERTER, type PdfConverter } from '../../src/modules/documents/pdf/pdf-converter.js';
import { DocumentEngineService } from '../../src/modules/documents/services/document-engine.service.js';
import { scalar, useSharedStorage } from './helpers.js';

const FORMAT = 'OCI-21-37';

class BlankPdfConverter implements PdfConverter {
  async toPdf(): Promise<Buffer> {
    const pdf = await PDFDocument.create();
    pdf.addPage([612, 792]);
    return Buffer.from(await pdf.save());
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

/**
 * Compara una respuesta real contra el esquema publicado en OpenAPI: sobran o faltan propiedades, null no declarado,
 * tipo o enum distinto. Es lo que detecta que el frontend (que genera sus tipos del OpenAPI) quedó desalineado.
 */
const conform = (openapi: OpenAPIObject, value: unknown, schema: Schema, path: string, errors: string[]): void => {
  const components = (openapi.components?.schemas ?? {}) as Record<string, Schema>;
  const resolve = (item: Schema): Schema => {
    if (item.$ref) {
      return resolve(components[item.$ref.replace('#/components/schemas/', '')] ?? {});
    }
    const { allOf, ...own } = item;
    if (allOf) {
      // allOf: el envelope + { data } o un $ref con nullable/description al lado. Las partes posteriores ganan.
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
  const actual = typeof value;
  const expected: Record<string, (item: unknown) => boolean> = {
    string: (item) => typeof item === 'string',
    integer: (item) => Number.isInteger(item),
    number: (item) => typeof item === 'number',
    boolean: (item) => typeof item === 'boolean',
  };
  if (type && expected[type] && !expected[type](value)) {
    errors.push(`${path}: se esperaba ${type} y llegó ${actual}`);
  }
  if (!type && !resolved.enum) {
    errors.push(`${path}: el esquema no declara tipo (queda como Object en el cliente generado)`);
  }
};

describe('Contrato OpenAPI de documentos: las respuestas reales cumplen el esquema publicado', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let openapi: OpenAPIObject;
  let templateId = '';
  let sequenceBefore: string | undefined;

  const http = () => request(app.getHttpServer());

  const person = async (first: string) => {
    const tag = randomUUID().slice(0, 8);
    const personId = await scalar<string>(
      dataSource,
      `INSERT INTO person (first_name, last_name, email, document_type, document_number)
       VALUES ($1, 'Contrato', $2, 'CC', $3) RETURNING id`,
      [first, `contrato.${tag}@unac.edu.co`, `8${Date.now().toString().slice(-9)}`],
    );
    const userId = await scalar<string>(
      dataSource,
      `INSERT INTO app_user (person_id, username, password_hash, mfa_enabled, status) VALUES ($1, $2, 'x', TRUE, 'ACTIVE') RETURNING id`,
      [personId, `contrato.${tag}`],
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
      username: `contrato.${tag}`,
      roles: [],
      scopes: [],
      mustChangePassword: false,
      sessionId,
    });
    return { userId, personId, token };
  };

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

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PDF_CONVERTER)
      .useValue(new BlankPdfConverter())
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
    dataSource = app.get(DataSource);
    await useSharedStorage(dataSource);
    openapi = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    sequenceBefore = await scalar<string | undefined>(
      dataSource,
      `SELECT current_value FROM document_sequence WHERE format_key = $1 AND period = ''`,
      [FORMAT],
    );
  });

  afterAll(async () => {
    // OCI-21-37 queda como estaba: otro archivo espera que no tenga plantilla.
    const ids = (
      (await dataSource.query('SELECT id FROM document WHERE template_version_id = $1', [templateId || null])) as Array<{ id: string }>
    ).map((item) => item.id);
    await dataSource.query('DELETE FROM document_signature_reassignment WHERE document_id = ANY($1)', [ids]);
    await dataSource.query(
      `DELETE FROM signature_envelope_signer WHERE envelope_id IN (SELECT id FROM signature_envelope WHERE document_id = ANY($1))`,
      [ids],
    );
    await dataSource.query('DELETE FROM signature_envelope WHERE document_id = ANY($1)', [ids]);
    await dataSource.query('DELETE FROM document_request WHERE format_key = $1', [FORMAT]);
    await dataSource.query('DELETE FROM document WHERE id = ANY($1)', [ids]);
    await dataSource.query('DELETE FROM document_template_version WHERE id = $1', [templateId || null]);
    await dataSource.query(`DELETE FROM document_sequence WHERE format_key = $1`, [FORMAT]);
    if (sequenceBefore !== undefined) {
      await dataSource.query(`INSERT INTO document_sequence (format_key, period, current_value) VALUES ($1, '', $2)`, [
        FORMAT,
        sequenceBefore,
      ]);
    }
    await app.close();
  });

  it('formatos, generación, detalle, reasignación, firma, sync, rechazo, lista, reintento y verificación pública', async () => {
    const director = await person('Directora');
    await dataSource.query(
      `INSERT INTO user_role (user_id, role_id, scope_type) SELECT $1, id, 'GLOBAL' FROM role WHERE code = 'INTERNAL_CONTROL_DIRECTOR'`,
      [director.userId],
    );
    const responsible = await person('Responsable');
    const auditor = await person('Auditora');
    const rubric = `data:image/png;base64,${(await QRCode.toBuffer('rubrica', { width: 120 })).toString('base64')}`;
    const auth = (who: { token: string }) => ({ Authorization: `Bearer ${who.token}` });

    const uploaded = await app
      .get(DocumentEngineService)
      .uploadTemplate(
        FORMAT,
        { buffer: await readFile('templates/formats/OCI-01-55-v2.docx'), originalname: 'plantilla.docx' },
        { sgcVersion: '9', effectiveDate: '2026-01-15' },
        director.userId,
      );
    templateId = uploaded.id ?? '';

    const formats = await http().get('/api/v1/documents/formats').set(auth(director)).expect(200);
    expectConforms('get', '/api/v1/documents/formats', 200, formats.body);

    const created = await http()
      .post('/api/v1/documents')
      .set(auth(director))
      .send({ formatKey: FORMAT, responsiblePersonId: auditor.personId, signers: { AUDITA: director.personId } })
      .expect(201);
    expectConforms('post', '/api/v1/documents', 201, created.body);
    const documentId = created.body.data.id as string;

    const detail = await http().get(`/api/v1/documents/${documentId}`).set(auth(director)).expect(200);
    expect(detail.body.data.currentTurn).not.toBeNull();
    expect(detail.body.data.verification).not.toBeNull();
    expectConforms('get', '/api/v1/documents/{id}', 200, detail.body);
    // El comparador sí detecta drift: una propiedad no declarada y un null no declarado.
    const drift: string[] = [];
    const detailSchema = (openapi.paths['/api/v1/documents/{id}'] as { get: { responses: Record<string, { content: Record<string, { schema: Schema }> }> } })
      .get.responses['200']?.content['application/json']?.schema;
    conform(openapi, { ...detail.body, data: { ...detail.body.data, extra: 1, number: null } }, detailSchema ?? {}, 'detalle', drift);
    expect(drift).toEqual([
      'detalle.data.extra: la respuesta la trae y el esquema no la declara',
      'detalle.data.number: es null y el esquema no lo declara nullable',
    ]);

    const reassigned = await http()
      .post(`/api/v1/documents/${documentId}/signatures/1/reassign`)
      .set(auth(director))
      .send({ personId: responsible.personId, reason: 'Cambio de responsable del área' })
      .expect(200);
    expect(reassigned.body.data.reassignments).toHaveLength(1);
    expectConforms('post', '/api/v1/documents/{id}/signatures/{order}/reassign', 200, reassigned.body);

    const first = await http().post(`/api/v1/documents/${documentId}/signatures/1`).set(auth(responsible)).send({ rubric }).expect(200);
    expectConforms('post', '/api/v1/documents/{id}/signatures/{order}', 200, first.body);
    const second = await http().post(`/api/v1/documents/${documentId}/signatures/2`).set(auth(director)).send({ rubric }).expect(200);
    expect(second.body.data).toMatchObject({ status: 'SIGNED', currentTurn: null });
    expect(second.body.data.signedPdfSha256).toEqual(expect.any(String));
    expectConforms('post', '/api/v1/documents/{id}/signatures/{order}', 200, second.body);

    const synced = await http().post(`/api/v1/documents/${documentId}/signatures/sync`).set(auth(director)).expect(200);
    expectConforms('post', '/api/v1/documents/{id}/signatures/sync', 200, synced.body);

    const code = synced.body.data.verification.code as string;
    const attestation = await http().get(`/api/v1/public/signatures/${code}`).expect(200);
    expect(attestation.body.data.status).toBe('COMPLETED');
    expectConforms('get', '/api/v1/public/signatures/{code}', 200, attestation.body);

    const toReject = await http()
      .post('/api/v1/documents')
      .set(auth(director))
      .send({ formatKey: FORMAT, responsiblePersonId: responsible.personId, signers: { AUDITA: director.personId } })
      .expect(201);
    const rejected = await http()
      .post(`/api/v1/documents/${toReject.body.data.id}/signatures/1/reject`)
      .set(auth(responsible))
      .send({ reason: 'El inventario no coincide' })
      .expect(200);
    expect(rejected.body.data.status).toBe('REJECTED');
    expectConforms('post', '/api/v1/documents/{id}/signatures/{order}/reject', 200, rejected.body);

    const requestId = await scalar<string>(
      dataSource,
      `INSERT INTO document_request (format_key, payload, status, attempts, last_error, requested_by)
       VALUES ($1, $2, 'FAILED', 5, 'fallo de prueba', $3) RETURNING id`,
      [FORMAT, JSON.stringify({ formatKey: FORMAT }), director.userId],
    );
    const list = await http().get('/api/v1/documents').query({ formatKey: FORMAT, pageSize: 100 }).set(auth(director)).expect(200);
    expect(list.body.data.items.map((item: { status: string }) => item.status)).toEqual(
      expect.arrayContaining(['FAILED', 'SIGNED', 'REJECTED']),
    );
    expectConforms('get', '/api/v1/documents', 200, list.body);

    const retried = await http().post(`/api/v1/documents/requests/${requestId}/retry`).set(auth(director)).expect(200);
    expect(retried.body.data.status).toBe('PENDING_GENERATION');
    expectConforms('post', '/api/v1/documents/requests/{requestId}/retry', 200, retried.body);
  });
});
