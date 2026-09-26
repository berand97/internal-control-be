import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
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
import { DocumentEngineService } from '../../src/modules/documents/services/document-engine.service.js';
import { PDF_CONVERTER } from '../../src/modules/documents/pdf/pdf-converter.js';
import { createActor, scalar, useSharedStorage } from './helpers.js';
import { DocxTextPdfConverter, pdfText, squash } from './pdf-text.js';

const TEMPLATE = 'templates/formats/OCI-01-55-v2.docx';
const FORMAT = 'OCI-17-90-BAJA';

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
  let replacement: Person;
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
      `INSERT INTO refresh_token_family (id, user_id, current_jti, expires_at, mfa_verified_at)
       VALUES ($1, $2, $3, NOW() + interval '1 day', (SELECT CASE WHEN mfa_enabled THEN NOW() END FROM app_user WHERE id = $2))`,
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
      .useValue(new DocxTextPdfConverter())
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
    replacement = await person('Reemplazo', true);
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
    await expect(generate(false)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const unassigned = await generate(true);
    await dataSource.query(
      `UPDATE document_signature SET signer_person_id = NULL, signer_name = NULL WHERE document_id = $1 AND sign_order = 2`,
      [unassigned.id],
    );
    await dataSource.query(
      `UPDATE signature_envelope_signer SET person_id = NULL WHERE sign_order = 2
       AND envelope_id = (SELECT id FROM signature_envelope WHERE document_id = $1)`,
      [unassigned.id],
    );

    const notDesignated = await sign(assigned.id, 1, stranger);
    expect([notDesignated.status, notDesignated.body.error.code]).toEqual([403, 'SIGNATURE_NOT_DESIGNATED_SIGNER']);

    await sign(assigned.id, 1, responsible).expect(200);
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

  it('MFA habilitado pero sesión abierta solo con contraseña: bloqueado en Control Interno y SESSION en los demás turnos', async () => {
    const document = await generate(true);
    const passwordOnly = [responsible.sessionId, auditor.sessionId];
    await dataSource.query('UPDATE refresh_token_family SET mfa_verified_at = NULL WHERE id = ANY($1)', [passwordOnly]);
    try {
      const first = await sign(document.id, 1, responsible);
      expect(first.status).toBe(200);
      expect(first.body.data.signatures[0]).toMatchObject({ status: 'SIGNED', method: 'SESSION', methodLabel: 'Sesión' });
      // canReassign pasa a false tras la primera firma, aunque el acta siga pendiente.
      expect((await detail(document.id, director)).viewer).toMatchObject({ canReassign: false });

      const blocked = await sign(document.id, 2, auditor);
      expect([blocked.status, blocked.body.error.code]).toEqual([403, 'SIGNATURE_MFA_REQUIRED']);
      expect((await detail(document.id, auditor)).viewer).toMatchObject({ canSign: false, blockedBy: 'SIGNATURE_MFA_REQUIRED' });
    } finally {
      await dataSource.query('UPDATE refresh_token_family SET mfa_verified_at = NOW() WHERE id = ANY($1)', [passwordOnly]);
    }
    const done = await sign(document.id, 2, auditor).expect(200);
    expect(done.body.data.signatures[1]).toMatchObject({ method: 'SESSION_MFA' });
  });

  it('reasignar valida que la persona pueda firmar el turno por algún camino', async () => {
    const document = await generate(true);
    const bare = async (documentNumber: string | null, active = true) => {
      const tag = randomUUID().slice(0, 8);
      return scalar<string>(
        dataSource,
        `INSERT INTO person (first_name, last_name, email, document_type, document_number, is_active)
         VALUES ('Sin usuario', $1, $2, 'CC', $3, $4) RETURNING id`,
        [tag, `sinusuario.${tag}@unac.edu.co`, documentNumber, active],
      );
    };
    // Turno de Control Interno: una persona sin usuario no puede firmarlo.
    const noUser = await bare(`6${Date.now().toString().slice(-9)}`);
    const ci = await reassign(document.id, 2, director, noUser);
    expect([ci.status, ci.body.error.code]).toEqual([409, 'SIGNATURE_SIGNER_CANNOT_SIGN']);
    expect(ci.body.error.details).toEqual([{ field: 'personId', message: 'SIGNATURE_NO_CHANNEL' }]);
    // Usuario con MFA deshabilitado en turno CI.
    const noMfa = await person('SinMfa', false);
    const ciNoMfa = await reassign(document.id, 2, director, noMfa.personId);
    expect(ciNoMfa.body.error.details).toEqual([{ field: 'personId', message: 'SIGNATURE_MFA_REQUIRED' }]);
    // Turno no CI: sin usuario y sin número de documento no hay confirmación de identidad.
    const noDocument = await bare(null);
    const nd = await reassign(document.id, 1, director, noDocument);
    expect(nd.body.error.details).toEqual([{ field: 'personId', message: 'SIGNATURE_NO_IDENTITY_CHECK' }]);
    // Persona inactiva.
    const inactive = await bare(`5${Date.now().toString().slice(-9)}`, false);
    const ina = await reassign(document.id, 1, director, inactive);
    expect(ina.body.error.details).toEqual([{ field: 'personId', message: 'SIGNATURE_SIGNER_INACTIVE' }]);
    // Sin usuario, con correo y documento: firma por enlace, se acepta.
    const byLink = await reassign(document.id, 1, director, noUser);
    expect(byLink.status).toBe(200);
    expect(byLink.body.data.currentTurn).toMatchObject({ order: 1, personId: noUser, channel: 'EMAIL_LINK', blockedBy: null });
  });

  it('reasignar antes de la primera firma reemite el acta y el PDF final nombra a quien firmó', async () => {
    const document = await generate(true);
    const envelopeBefore = (await dataSource.query('SELECT verification_code, current_pdf_sha256 FROM signature_envelope WHERE document_id = $1', [document.id])) as Array<{ verification_code: string; current_pdf_sha256: string }>;
    const pdfBefore = await scalar<string>(dataSource, 'SELECT pdf_hash FROM document WHERE id = $1', [document.id]);
    const originalText = squash(await pdfText((await engine.download(document.id, 'pdf', director.userId)).body));
    expect(originalText).toContain('Auditora Turnos');

    const denied = await reassign(document.id, 2, stranger, replacement.personId);
    expect([denied.status, denied.body.error.code]).toEqual([403, 'INSUFFICIENT_PERMISSIONS']);

    const reassigned = await reassign(document.id, 2, director, replacement.personId);
    expect(reassigned.status).toBe(200);
    expect(reassigned.body.data.number).toBe(document.number);
    expect(reassigned.body.data.currentTurn).toMatchObject({ order: 1, personId: responsible.personId });
    expect(reassigned.body.data.reassignments).toEqual([
      expect.objectContaining({
        order: 2,
        role: 'AUDITA',
        fromPersonId: auditor.personId,
        toPersonId: replacement.personId,
        toName: 'Reemplazo Turnos',
        reason: 'La auditora designada está en vacaciones',
        reassignedBy: director.userId,
        previousPdfSha256: pdfBefore,
        newPdfSha256: expect.not.stringMatching(pdfBefore),
      }),
    ]);
    const [evidence] = (await dataSource.query(
      `SELECT session_id, host(ip_address) AS ip FROM document_signature_reassignment WHERE document_id = $1`,
      [document.id],
    )) as Array<{ session_id: string; ip: string }>;
    expect(evidence).toEqual({ session_id: director.sessionId, ip: '203.0.113.61' });
    const envelopeAfter = (await dataSource.query('SELECT verification_code, current_pdf_sha256 FROM signature_envelope WHERE document_id = $1', [document.id])) as Array<{ verification_code: string; current_pdf_sha256: string }>;
    expect(envelopeAfter[0]?.verification_code).toBe(envelopeBefore[0]?.verification_code);
    expect(envelopeAfter[0]?.current_pdf_sha256).not.toBe(envelopeBefore[0]?.current_pdf_sha256);

    const oldAuditor = await sign(document.id, 2, auditor);
    expect(oldAuditor.body.error.code).toBe('SIGNATURE_NOT_DESIGNATED_SIGNER');
    await sign(document.id, 1, responsible).expect(200);
    const late = await reassign(document.id, 2, director, auditor.personId);
    expect([late.status, late.body.error.code]).toEqual([409, 'SIGNATURE_REASSIGN_AFTER_SIGNING']);

    const finished = (await sign(document.id, 2, replacement).expect(200)).body.data;
    expect(finished.status).toBe('SIGNED');
    const finalText = squash(await pdfText((await engine.download(document.id, 'pdf', director.userId)).body));
    expect(finalText).toContain('Reemplazo Turnos');
    expect(finalText).not.toContain('Auditora Turnos');
    const code = envelopeAfter[0]?.verification_code ?? '';
    const attestation = (await http().get(`/api/v1/public/signatures/${code}`)).body.data;
    expect(attestation).toMatchObject({ status: 'COMPLETED', integrity: 'INTACT' });
    expect(attestation.signers.map((item: { name: string }) => item.name)).toEqual(['Responsable Turnos', 'Reemplazo Turnos']);
  });
});
