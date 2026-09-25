import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
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
import { createActor, scalar, useSharedStorage } from './helpers.js';

const TEMPLATE = 'templates/formats/OCI-01-55-v2.docx';
const FORMAT = 'OCI-17-90-BAJA';

class BlankPdfConverter implements PdfConverter {
  async toPdf(): Promise<Buffer> {
    const pdf = await PDFDocument.create();
    pdf.addPage([612, 792]);
    return Buffer.from(await pdf.save());
  }
}

interface Person {
  userId: string;
  personId: string;
  sessionId: string;
  token: string;
}

describe('Turnos de firma: códigos de error, detalle por usuario y reasignación (HTTP real + PostgreSQL real)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let engine: DocumentEngineService;
  let director: Person;
  let responsible: Person;
  let auditor: Person;
  let stranger: Person;
  let rubric: string;

  const http = () => request(app.getHttpServer());

  const person = async (first: string, mfa: boolean): Promise<Person> => {
    const tag = randomUUID().slice(0, 8);
    const personId = await scalar<string>(
      dataSource,
      `INSERT INTO person (first_name, last_name, email, document_type, document_number)
       VALUES ($1, 'Turnos', $2, 'CC', $3) RETURNING id`,
      [first, `turnos.${tag}@unac.edu.co`, `9${Date.now().toString().slice(-9)}`],
    );
    const userId = await scalar<string>(
      dataSource,
      `INSERT INTO app_user (person_id, username, password_hash, mfa_enabled, status) VALUES ($1, $2, 'x', $3, 'ACTIVE') RETURNING id`,
      [personId, `turnos.${tag}`, mfa],
    );
    const sessionId = randomUUID();
    await dataSource.query(
      `INSERT INTO refresh_token_family (id, user_id, current_jti, expires_at) VALUES ($1, $2, $3, NOW() + interval '1 day')`,
      [sessionId, userId, randomUUID()],
    );
    const token = app.get(TokenService).signAccessToken({
      id: userId,
      personId,
      username: `turnos.${tag}`,
      roles: [],
      scopes: [],
      mustChangePassword: false,
      sessionId,
    });
    return { userId, personId, sessionId, token };
  };

  const detail = async (documentId: string, who: Person) =>
    (await http().get(`/api/v1/documents/${documentId}`).set('Authorization', `Bearer ${who.token}`)).body.data;

  const sign = (documentId: string, order: number, who: Person) =>
    http()
      .post(`/api/v1/documents/${documentId}/signatures/${order}`)
      .set('Authorization', `Bearer ${who.token}`)
      .set('X-Forwarded-For', '203.0.113.60')
      .send({ rubric });

  const reassign = (documentId: string, order: number, who: Person, personId: string) =>
    http()
      .post(`/api/v1/documents/${documentId}/signatures/${order}/reassign`)
      .set('Authorization', `Bearer ${who.token}`)
      .set('X-Forwarded-For', '203.0.113.61')
      .send({ personId, reason: 'La auditora designada está en vacaciones' });

  const generate = (withAuditor: boolean) =>
    engine.generate(
      {
        formatKey: FORMAT,
        responsiblePersonId: responsible.personId,
        ...(withAuditor ? { signers: { AUDITA: auditor.personId } } : {}),
      },
      director.userId,
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PDF_CONVERTER)
      .useValue(new BlankPdfConverter())
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    applyTrustProxy(app, app.get(ConfigService<AppConfig, true>).getOrThrow('trustProxy', { infer: true }));
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
    dataSource = app.get(DataSource);
    engine = app.get(DocumentEngineService);
    await useSharedStorage(dataSource);

    const actor = await createActor(dataSource);
    await dataSource.query(
      `INSERT INTO user_role (user_id, role_id, scope_type) SELECT $1, id, 'GLOBAL' FROM role WHERE code = 'INTERNAL_CONTROL_DIRECTOR'`,
      [actor.id],
    );
    director = { ...(await person('Directora', true)) };
    await dataSource.query(
      `INSERT INTO user_role (user_id, role_id, scope_type) SELECT $1, id, 'GLOBAL' FROM role WHERE code = 'INTERNAL_CONTROL_DIRECTOR'`,
      [director.userId],
    );
    responsible = await person('Responsable', true);
    auditor = await person('Auditora', true);
    stranger = await person('Ajeno', true);
    rubric = `data:image/png;base64,${(await QRCode.toBuffer('rubrica', { width: 120 })).toString('base64')}`;
    await engine.uploadTemplate(
      FORMAT,
      { buffer: await readFile(TEMPLATE), originalname: 'plantilla.docx' },
      { sgcVersion: '1', effectiveDate: '2026-02-02' },
      director.userId,
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('cada situación devuelve su propio código, con el mismo HTTP 403', async () => {
    const assigned = await generate(true);
    const unassigned = await generate(false);

    const notDesignated = await sign(assigned.id, 1, stranger);
    expect([notDesignated.status, notDesignated.body.error.code]).toEqual([403, 'SIGNATURE_NOT_DESIGNATED_SIGNER']);

    await sign(assigned.id, 1, responsible).expect(200);
    const beforeTurn = await sign(unassigned.id, 2, auditor);
    expect([beforeTurn.status, beforeTurn.body.error.code]).toEqual([403, 'SIGNATURE_SIGNER_UNASSIGNED']);
    await sign(unassigned.id, 1, responsible).expect(200);
    const unassignedTurn = await sign(unassigned.id, 2, auditor);
    expect([unassignedTurn.status, unassignedTurn.body.error.code]).toEqual([403, 'SIGNATURE_SIGNER_UNASSIGNED']);

    await dataSource.query('UPDATE app_user SET mfa_enabled = FALSE WHERE id = $1', [auditor.userId]);
    const noMfa = await sign(assigned.id, 2, auditor);
    expect([noMfa.status, noMfa.body.error.code]).toEqual([403, 'SIGNATURE_MFA_REQUIRED']);
    await dataSource.query('UPDATE app_user SET mfa_enabled = TRUE WHERE id = $1', [auditor.userId]);

    await dataSource.query(`UPDATE refresh_token_family SET status = 'REVOKED', revoked_at = NOW() WHERE id = $1`, [auditor.sessionId]);
    const revoked = await sign(assigned.id, 2, auditor);
    expect([revoked.status, revoked.body.error.code]).toEqual([403, 'SIGNATURE_SESSION_INVALID']);
    await dataSource.query(`UPDATE refresh_token_family SET status = 'ACTIVE', revoked_at = NULL WHERE id = $1`, [auditor.sessionId]);

    const codes = new Set([notDesignated, unassignedTurn, noMfa, revoked].map((response) => response.body.error.code));
    expect(codes.size).toBe(4);
  });

  it('el detalle dice de quién es el turno y qué pasaría si el usuario intenta firmar', async () => {
    const document = await generate(true);

    const forResponsible = await detail(document.id, responsible);
    expect(forResponsible.currentTurn).toMatchObject({ order: 1, role: 'RESPONSABLE', roleLabel: 'Responsable', personId: responsible.personId, assigned: true });
    expect(forResponsible.viewer).toMatchObject({ signerOrders: [1], isCurrentSigner: true, nextOrder: 1, canSign: true, blockedBy: null, canReassign: false });

    const forAuditor = await detail(document.id, auditor);
    expect(forAuditor.viewer).toMatchObject({ signerOrders: [2], isCurrentSigner: false, nextOrder: 2, canSign: false, blockedBy: 'SIGNATURE_OUT_OF_ORDER' });

    const forDirector = await detail(document.id, director);
    expect(forDirector.viewer).toMatchObject({ signerOrders: [], isCurrentSigner: false, canSign: false, blockedBy: null, canReassign: true });

    await sign(document.id, 1, responsible).expect(200);
    const afterFirst = await detail(document.id, auditor);
    expect(afterFirst.currentTurn).toMatchObject({ order: 2, role: 'AUDITA', personId: auditor.personId });
    expect(afterFirst.viewer).toMatchObject({ isCurrentSigner: true, canSign: true, blockedBy: null });

    await dataSource.query('UPDATE app_user SET mfa_enabled = FALSE WHERE id = $1', [auditor.userId]);
    expect((await detail(document.id, auditor)).viewer).toMatchObject({ isCurrentSigner: true, canSign: false, blockedBy: 'SIGNATURE_MFA_REQUIRED' });
    await dataSource.query('UPDATE app_user SET mfa_enabled = TRUE WHERE id = $1', [auditor.userId]);

    const done = (await sign(document.id, 2, auditor).expect(200)).body.data;
    expect(done.status).toBe('SIGNED');
    expect(done.currentTurn).toBeNull();
    expect(done.viewer).toMatchObject({ isCurrentSigner: false, canSign: false, nextOrder: null });
  });

  it('reasignar un turno sin persona queda como evidencia y deja avanzar el documento', async () => {
    const document = await generate(false);
    await sign(document.id, 1, responsible).expect(200);
    expect((await detail(document.id, director)).currentTurn).toMatchObject({ order: 2, personId: null, assigned: false });
    const notYetSigner = await http().get(`/api/v1/documents/${document.id}`).set('Authorization', `Bearer ${auditor.token}`);
    expect(notYetSigner.status).toBe(403);

    const denied = await reassign(document.id, 2, stranger, auditor.personId);
    expect([denied.status, denied.body.error.code]).toEqual([403, 'INSUFFICIENT_PERMISSIONS']);
    const signedTurn = await reassign(document.id, 1, director, auditor.personId);
    expect(signedTurn.body.error.code).toBe('INVALID_STATE');

    const reassigned = await reassign(document.id, 2, director, auditor.personId);
    expect(reassigned.status).toBe(200);
    expect(reassigned.body.data.currentTurn).toMatchObject({ order: 2, personId: auditor.personId, assigned: true });
    expect(reassigned.body.data.reassignments).toEqual([
      expect.objectContaining({
        order: 2,
        role: 'AUDITA',
        fromPersonId: null,
        toPersonId: auditor.personId,
        toName: 'Auditora Turnos',
        reason: 'La auditora designada está en vacaciones',
        reassignedBy: director.userId,
      }),
    ]);
    const [evidence] = (await dataSource.query(
      `SELECT session_id, host(ip_address) AS ip FROM document_signature_reassignment WHERE document_id = $1`,
      [document.id],
    )) as Array<{ session_id: string; ip: string }>;
    expect(evidence).toEqual({ session_id: director.sessionId, ip: '203.0.113.61' });
    const same = await reassign(document.id, 2, director, auditor.personId);
    expect(same.body.error.code).toBe('VALIDATION_FAILED');

    const finished = (await sign(document.id, 2, auditor).expect(200)).body.data;
    expect(finished.status).toBe('SIGNED');
    const code = await scalar<string>(dataSource, 'SELECT verification_code FROM signature_envelope WHERE document_id = $1', [document.id]);
    const attestation = (await http().get(`/api/v1/public/signatures/${code}`)).body.data;
    expect(attestation).toMatchObject({ status: 'COMPLETED', integrity: 'INTACT' });
    expect(attestation.signers.map((item: { name: string }) => item.name)).toEqual(['Responsable Turnos', 'Auditora Turnos']);
  });
});
