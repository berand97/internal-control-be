import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import QRCode from 'qrcode';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';
import { createAppValidationPipe } from '../../src/common/pipes/app-validation.pipe.js';
import { TokenService } from '../../src/modules/auth/services/token.service.js';
import { PDF_CONVERTER, type PdfConverter } from '../../src/modules/documents/pdf/pdf-converter.js';
import { DocumentEngineService } from '../../src/modules/documents/services/document-engine.service.js';
import { createActor, scalar, useSharedStorage } from './helpers.js';

const TEMPLATE = 'templates/formats/OCI-01-55-v2.docx';
const FORMAT = 'OCI-17-90-INFORME';

class ControlledPdfConverter implements PdfConverter {
  failures = 0;
  calls = 0;
  async toPdf(): Promise<Buffer> {
    this.calls += 1;
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('Gotenberg no respondió (simulado)');
    }
    const pdf = await PDFDocument.create();
    pdf.addPage([612, 792]);
    return Buffer.from(await pdf.save());
  }
}

interface ListItem {
  id: string;
  documentId: string | null;
  requestId: string | null;
  formatKey: string;
  number: string | null;
  status: string;
  createdAt: string;
  requestedBy: { userId: string; name: string | null } | null;
  asset: { id: string; code: string; description: string } | null;
  assetCount: number;
  error: string | null;
  attempts: number | null;
  retriesAutomatically: boolean;
  retryable: boolean;
}

describe('GET /documents y reintento por el outbox (HTTP real + PostgreSQL real)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let engine: DocumentEngineService;
  const converter = new ControlledPdfConverter();
  let director: AuthenticatedUser;
  let directorToken: string;
  let outsiderToken: string;
  let signer: AuthenticatedUser;
  let assetId: string;

  const http = () => request(app.getHttpServer());
  const list = async (query: Record<string, string | number>, token = directorToken) => {
    const response = await http().get('/api/v1/documents').query(query).set('Authorization', `Bearer ${token}`);
    return response;
  };
  const items = async (query: Record<string, string | number>) => (await list(query)).body.data as { items: ListItem[]; total: number; hasNext: boolean };
  const today = new Date().toISOString().slice(0, 10);
  const totalsByStatus = async () => {
    const statuses = ['PENDING_GENERATION', 'FAILED', 'PENDING_SIGNATURE', 'SIGNED', 'REJECTED'];
    const totals: Record<string, number> = {};
    for (const status of statuses) {
      totals[status] = (await items({ formatKey: FORMAT, status, pageSize: 1 })).total;
    }
    return totals;
  };

  const tokenFor = async (user: AuthenticatedUser, withSession: boolean) => {
    const sessionId = randomUUID();
    if (withSession) {
      await dataSource.query(
        `INSERT INTO refresh_token_family (id, user_id, current_jti, expires_at) VALUES ($1, $2, $3, NOW() + interval '1 day')`,
        [sessionId, user.id, randomUUID()],
      );
    }
    return { token: app.get(TokenService).signAccessToken({ ...user, sessionId }), sessionId };
  };

  const enqueue = () =>
    dataSource.transaction((manager) =>
      engine.enqueue(manager, { formatKey: FORMAT, assetIds: [assetId], signers: { AUDITA: signer.personId } }, director.id),
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PDF_CONVERTER)
      .useValue(converter)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
    dataSource = app.get(DataSource);
    engine = app.get(DocumentEngineService);
    await useSharedStorage(dataSource);

    director = await createActor(dataSource);
    await dataSource.query(
      `INSERT INTO user_role (user_id, role_id, scope_type) SELECT $1, id, 'GLOBAL' FROM role WHERE code = 'INTERNAL_CONTROL_DIRECTOR'`,
      [director.id],
    );
    directorToken = (await tokenFor(director, false)).token;
    outsiderToken = (await tokenFor(await createActor(dataSource), false)).token;
    signer = await createActor(dataSource);
    await dataSource.query('UPDATE app_user SET mfa_enabled = TRUE WHERE id = $1', [signer.id]);

    const costCenterId = await scalar<string>(
      dataSource,
      `INSERT INTO cost_center (external_code, name) VALUES ('DL-1', 'Listado') RETURNING id`,
    );
    const categoryId = await scalar<string>(
      dataSource,
      `INSERT INTO asset_category (code, name, requires_photo) VALUES ('DL', 'Listado', FALSE) RETURNING id`,
    );
    assetId = await scalar<string>(
      dataSource,
      `INSERT INTO asset (internal_code, description, category_id, acquisition_type_id, acquisition_date,
         current_cost_center_id, created_by, physical_condition)
       VALUES ('DL-0001', 'Escáner de listado', $1, (SELECT id FROM acquisition_type WHERE code = 'PURCHASE'), '2020-01-01', $2, $3, 'GOOD')
       RETURNING id`,
      [categoryId, costCenterId, director.id],
    );
    await dataSource.query(
      `INSERT INTO asset_identifier (asset_id, identifier_type, value, origin) VALUES ($1, 'LEGACY_CODE', 'DL-777', 'IMPORTED')`,
      [assetId],
    );
    await engine.uploadTemplate(
      FORMAT,
      { buffer: await readFile(TEMPLATE), originalname: 'plantilla.docx' },
      { sgcVersion: '1', effectiveDate: '2026-03-01' },
      director.id,
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('lista estados reales, filtra con conteos correctos y reencola una falla que el outbox genera', async () => {
    const before = await totalsByStatus();
    const payload = { formatKey: FORMAT, assetIds: [assetId], signers: { AUDITA: signer.personId } };

    const pending = await engine.generate(payload, director.id);
    const signed = await engine.generate(payload, director.id);
    const rejected = await engine.generate(payload, director.id);
    const signerSession = await tokenFor(signer, true);
    const signerActor = { ...signer, sessionId: signerSession.sessionId };
    const rubric = await QRCode.toBuffer('rubrica', { width: 120 });
    await engine.sign(signed.id, 1, signerActor, rubric, { ipAddress: '203.0.113.9', userAgent: 'vitest' });
    await engine.rejectSignature(rejected.id, 1, signerActor, 'El inventario no coincide', { ipAddress: null, userAgent: null });

    const exhaustedId = await enqueue();
    converter.failures = 5;
    for (let pass = 0; pass < 5; pass += 1) {
      await engine.processPending();
    }
    const failedOnceId = await enqueue();
    converter.failures = 1;
    await engine.processPending();
    const waitingId = await enqueue();

    const after = await totalsByStatus();
    expect(Object.fromEntries(Object.entries(after).map(([status, total]) => [status, total - (before[status] ?? 0)]))).toEqual({
      PENDING_GENERATION: 1,
      FAILED: 2,
      PENDING_SIGNATURE: 1,
      SIGNED: 1,
      REJECTED: 1,
    });

    const all = (await items({ formatKey: FORMAT, from: today, to: today, pageSize: 100 })).items;
    const byId = new Map(all.map((item) => [item.id, item]));
    expect(byId.get(pending.id)).toMatchObject({
      documentId: pending.id,
      number: pending.number,
      status: 'PENDING_SIGNATURE',
      requestedBy: { userId: director.id },
      asset: { id: assetId, code: 'DL-777', description: 'Escáner de listado' },
      assetCount: 1,
      error: null,
      retryable: false,
    });
    expect(byId.get(signed.id)?.status).toBe('SIGNED');
    expect(byId.get(rejected.id)?.status).toBe('REJECTED');
    expect(byId.get(exhaustedId)).toMatchObject({
      documentId: null,
      requestId: exhaustedId,
      number: null,
      status: 'FAILED',
      error: 'Gotenberg no respondió (simulado)',
      attempts: 5,
      retriesAutomatically: false,
      retryable: true,
      asset: { id: assetId, code: 'DL-777' },
    });
    expect(byId.get(failedOnceId)).toMatchObject({ status: 'FAILED', attempts: 1, retriesAutomatically: true });
    expect(byId.get(waitingId)).toMatchObject({ status: 'PENDING_GENERATION', error: null, retryable: false });

    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    expect((await items({ formatKey: FORMAT, from: tomorrow })).total).toBe(0);
    const olderIds = (await items({ formatKey: FORMAT, to: yesterday, pageSize: 100 })).items.map((item) => item.id);
    expect(olderIds).not.toContain(pending.id);
    const otherFormat = (await items({ formatKey: 'OCI-17-89', pageSize: 100 })).items.map((item) => item.id);
    expect(otherFormat).not.toContain(pending.id);
    expect(otherFormat).not.toContain(exhaustedId);

    const callsBefore = converter.calls;
    const retried = await http()
      .post(`/api/v1/documents/requests/${exhaustedId}/retry`)
      .set('Authorization', `Bearer ${directorToken}`);
    expect(retried.status).toBe(200);
    expect(retried.body.data).toMatchObject({ id: exhaustedId, status: 'PENDING_GENERATION', documentId: null, error: null });
    expect(converter.calls).toBe(callsBefore);
    expect(await scalar<string | null>(dataSource, 'SELECT document_id FROM document_request WHERE id = $1', [exhaustedId])).toBeNull();

    const again = await http().post(`/api/v1/documents/requests/${exhaustedId}/retry`).set('Authorization', `Bearer ${directorToken}`);
    expect(again.status).toBe(406);
    expect(again.body.error.code).toBe('INVALID_STATE');

    await engine.processPending();
    const documentId = await scalar<string | null>(dataSource, 'SELECT document_id FROM document_request WHERE id = $1', [exhaustedId]);
    expect(documentId).toBeTruthy();
    const generated = (await items({ formatKey: FORMAT, status: 'PENDING_SIGNATURE', pageSize: 100 })).items.find(
      (item) => item.requestId === exhaustedId,
    );
    expect(generated).toMatchObject({ id: documentId, documentId, status: 'PENDING_SIGNATURE', attempts: 6 });
    expect(generated?.number).toBeTruthy();
  });

  it('pagina con un desempate estable aunque created_at coincida', async () => {
    const payload = { formatKey: FORMAT, assetIds: [assetId], signers: { AUDITA: signer.personId } };
    const created = [];
    for (let index = 0; index < 4; index += 1) {
      created.push((await engine.generate(payload, director.id)).id);
    }
    await dataSource.query(`UPDATE document SET created_at = '2031-01-01T00:00:00Z' WHERE id = ANY($1)`, [created]);
    const seen: string[] = [];
    for (let page = 1; page <= 4; page += 1) {
      const result = await items({ formatKey: FORMAT, from: '2031-01-01', to: '2031-01-01', page, pageSize: 1 });
      expect(result.total).toBe(4);
      seen.push(...result.items.map((item) => item.id));
    }
    expect(seen).toEqual([...created].sort().reverse());
  });

  it('exige el permiso de lectura del proceso', async () => {
    const denied = await list({}, outsiderToken);
    expect(denied.status).toBe(403);
    expect((await list({ formatKey: 'NO-EXISTE' })).status).toBe(400);
    expect((await list({ status: 'CUALQUIERA' })).status).toBe(400);
  });
});
