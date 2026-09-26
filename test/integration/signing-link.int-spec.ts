import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import QRCode from 'qrcode';
import { SchedulerRegistry } from '@nestjs/schedule';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { applyTrustProxy } from '../../src/common/http/trust-proxy.js';
import { createAppValidationPipe } from '../../src/common/pipes/app-validation.pipe.js';
import type { AppConfig } from '../../src/config/configuration.js';
import { TokenService } from '../../src/modules/auth/services/token.service.js';
import { DocumentLifecycleRegistry } from '../../src/modules/documents/lifecycle/document-lifecycle.registry.js';
import { PDF_CONVERTER } from '../../src/modules/documents/pdf/pdf-converter.js';
import { DocumentEngineService } from '../../src/modules/documents/services/document-engine.service.js';
import { MailService } from '../../src/shared/mail/mail.service.js';
import { StorageService } from '../../src/shared/storage/storage.service.js';
import { scalar, useSharedStorage } from './helpers.js';
import { DocxTextPdfConverter, pdfText, squash } from './pdf-text.js';

const TEMPLATE = 'templates/formats/OCI-01-55-v2.docx';
const FORMAT = 'OCI-01-55';
const ENTITY = 'IT_SIGNING_LINK';

interface User {
  userId: string;
  personId: string;
  sessionId: string;
  token: string;
}

const longDate = (date: Date): string =>
  new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Bogota' })
    .format(date)
    .replaceAll(' de ', ' DE ')
    .toUpperCase();

describe('Tres caminos de firma: sesión con MFA, sesión y enlace de un solo uso por correo (HTTP real + PostgreSQL real)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let engine: DocumentEngineService;
  let director: User;
  let auditor: User;
  let rubric: string;
  let ipCounter = 0;
  let templateId = '';
  let sequenceBefore: string | undefined;
  /** Correos que "salieron": el token solo existe aquí (y en el correo real). */
  const outbox: Array<{ to: string; url: string }> = [];
  let smtpUp = true;
  /** Todo lo que la aplicación escribe en consola durante las pruebas. */
  let output = '';
  const lifecycleFailures = { onSigned: 0 };

  const http = () => request(app.getHttpServer());
  const ip = () => `198.51.100.${(ipCounter++ % 250) + 1}`;
  const tokenOf = (url: string) => url.split('/firmar/')[1] ?? '';
  const lastToken = () => tokenOf(outbox.at(-1)?.url ?? '');

  const user = async (first: string, mfa: boolean, documentNumber: string): Promise<User> => {
    const tag = randomUUID().slice(0, 8);
    const personId = await scalar<string>(
      dataSource,
      `INSERT INTO person (first_name, last_name, email, document_type, document_number)
       VALUES ($1, 'Enlace', $2, 'CC', $3) RETURNING id`,
      [first, `enlace.${tag}@unac.edu.co`, documentNumber],
    );
    const userId = await scalar<string>(
      dataSource,
      `INSERT INTO app_user (person_id, username, password_hash, mfa_enabled, status) VALUES ($1, $2, 'x', $3, 'ACTIVE') RETURNING id`,
      [personId, `enlace.${tag}`, mfa],
    );
    const sessionId = randomUUID();
    await dataSource.query(
      `INSERT INTO refresh_token_family (id, user_id, current_jti, expires_at, mfa_verified_at)
       VALUES ($1, $2, $3, NOW() + interval '1 day', CASE WHEN $4::boolean THEN NOW() END)`,
      [sessionId, userId, randomUUID(), mfa],
    );
    const token = app.get(TokenService).signAccessToken({
      id: userId,
      personId,
      username: `enlace.${tag}`,
      roles: [],
      scopes: [],
      mustChangePassword: false,
      sessionId,
    });
    return { userId, personId, sessionId, token };
  };

  /** Persona sin usuario: firma por enlace. */
  const outsider = (first: string, documentNumber: string | null) => {
    const tag = randomUUID().slice(0, 8);
    return scalar<string>(
      dataSource,
      `INSERT INTO person (first_name, last_name, email, document_type, document_number)
       VALUES ($1, 'Sin Usuario', $2, 'CC', $3) RETURNING id`,
      [first, `externa.${tag}@unac.edu.co`, documentNumber],
    );
  };

  const docNumber = () => `7${randomUUID().replace(/\D/g, '').padEnd(9, '0').slice(0, 9)}`;

  const generate = (responsiblePersonId: string, extra: { entityType?: string; entityId?: string } = {}) =>
    engine.generate({ formatKey: FORMAT, responsiblePersonId, signers: { AUDITA: auditor.personId }, ...extra }, director.userId);

  const detail = async (documentId: string, who: User = director) =>
    (await http().get(`/api/v1/documents/${documentId}`).set('Authorization', `Bearer ${who.token}`).expect(200)).body.data;

  const view = (token: string) => http().get(`/api/v1/public/signing-links/${token}`).set('X-Forwarded-For', ip());
  const identity = (token: string, last4: string) =>
    http().post(`/api/v1/public/signing-links/${token}/identity`).set('X-Forwarded-For', ip()).send({ last4 });
  const signByLink = (token: string, identityToken: string, from = ip()) =>
    http()
      .post(`/api/v1/public/signing-links/${token}/sign`)
      .set('X-Forwarded-For', from)
      .set('User-Agent', 'vitest-enlace')
      .send({ identityToken, rubric });
  const signBySession = (documentId: string, order: number, who: User) =>
    http()
      .post(`/api/v1/documents/${documentId}/signatures/${order}`)
      .set('Authorization', `Bearer ${who.token}`)
      .set('X-Forwarded-For', ip())
      .send({ rubric });

  const confirmedToken = async (token: string, documentNumber: string) => {
    const response = await identity(token, documentNumber.slice(-4));
    expect(response.status).toBe(200);
    return response.body.data.identityToken as string;
  };

  const linkRow = async (documentId: string) =>
    (
      (await dataSource.query('SELECT * FROM signature_signing_link WHERE document_id = $1 ORDER BY created_at DESC LIMIT 1', [
        documentId,
      ])) as Array<Record<string, unknown>>
    )[0];

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
    // El job de documentos corre cada minuto: se detiene para que el test decida cuándo se procesa el outbox.
    for (const job of app.get(SchedulerRegistry).getCronJobs().values()) {
      await job.stop();
    }
    dataSource = app.get(DataSource);
    engine = app.get(DocumentEngineService);
    await useSharedStorage(dataSource);

    const mail = app.get(MailService);
    const original = mail.sendSigningLink.bind(mail);
    vi.spyOn(mail, 'sendSigningLink').mockImplementation(async (to, context) => {
      if (!smtpUp) {
        // Sin SMTP configurado (estado de la BD de pruebas): el servicio real devuelve false.
        return original(to, context);
      }
      outbox.push({ to, url: context.url });
      return true;
    });
    for (const stream of [process.stdout, process.stderr]) {
      const write = stream.write.bind(stream);
      vi.spyOn(stream, 'write').mockImplementation(((chunk: string | Uint8Array, ...rest: unknown[]) => {
        output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
        return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof stream.write);
    }

    app.get(DocumentLifecycleRegistry).register({
      entityType: ENTITY,
      onSigned: () => {
        if (lifecycleFailures.onSigned > 0) {
          lifecycleFailures.onSigned -= 1;
          return Promise.reject(new Error('fallo simulado del proceso al cerrar el acta'));
        }
        return Promise.resolve();
      },
    });

    director = await user('Directora', true, docNumber());
    await dataSource.query(
      `INSERT INTO user_role (user_id, role_id, scope_type) SELECT $1, id, 'GLOBAL' FROM role WHERE code = 'INTERNAL_CONTROL_DIRECTOR'`,
      [director.userId],
    );
    auditor = await user('Auditora', true, docNumber());
    rubric = `data:image/png;base64,${(await QRCode.toBuffer('rubrica enlace', { width: 120 })).toString('base64')}`;
    sequenceBefore = await scalar<string | undefined>(
      dataSource,
      `SELECT current_value FROM document_sequence WHERE format_key = $1 AND period = ''`,
      [FORMAT],
    );
    // Vigente hoy para ganarle a cualquier otra plantilla del formato; se borra en afterAll.
    const uploaded = await engine.uploadTemplate(
      FORMAT,
      { buffer: await readFile(TEMPLATE), originalname: 'plantilla.docx' },
      { sgcVersion: '2', effectiveDate: new Date().toISOString().slice(0, 10) },
      director.userId,
    );
    templateId = uploaded.id ?? '';
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    // Deja OCI-01-55 como estaba: otros archivos esperan su consecutivo y su plantilla.
    const ids = (
      (await dataSource.query('SELECT id FROM document WHERE created_by = $1 OR template_version_id = $2', [
        director.userId,
        templateId,
      ])) as Array<{ id: string }>
    ).map((item) => item.id);
    await dataSource.query('DELETE FROM document_signature_reassignment WHERE document_id = ANY($1)', [ids]);
    await dataSource.query(
      'DELETE FROM signature_envelope_signer WHERE envelope_id IN (SELECT id FROM signature_envelope WHERE document_id = ANY($1))',
      [ids],
    );
    await dataSource.query('DELETE FROM signature_signing_link WHERE document_id = ANY($1)', [ids]);
    await dataSource.query('DELETE FROM signature_envelope WHERE document_id = ANY($1)', [ids]);
    await dataSource.query(`DELETE FROM document_request WHERE document_id = ANY($1) OR requested_by = $2 OR payload->>'entityType' = $3`, [
      ids,
      director.userId,
      ENTITY,
    ]);
    await dataSource.query('DELETE FROM document WHERE id = ANY($1)', [ids]);
    await dataSource.query('DELETE FROM document_template_version WHERE id = $1', [templateId]);
    await dataSource.query(`DELETE FROM document_sequence WHERE format_key = $1 AND period = ''`, [FORMAT]);
    if (sequenceBefore !== undefined) {
      await dataSource.query(`INSERT INTO document_sequence (format_key, period, current_value) VALUES ($1, '', $2)`, [
        FORMAT,
        sequenceBefore,
      ]);
    }
    await app.close();
  });

  it('los tres caminos en la misma acta: enlace (persona sin usuario) y luego Control Interno con sesión y MFA', async () => {
    const documentNumber = docNumber();
    const personId = await outsider('Laura', documentNumber);
    const document = await generate(personId);

    // El enlace se emitió y se "envió" al generar el acta; en BD solo queda su hash.
    const sent = outbox.at(-1);
    expect(sent?.url).toMatch(/\/firmar\/[A-Za-z0-9_-]{43}$/);
    const token = tokenOf(sent?.url ?? '');
    const row = await linkRow(document.id);
    expect(row).toMatchObject({ delivery_status: 'SENT', sign_order: 1, person_id: personId });
    expect(row?.['token_hash']).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(token);
    const hours = (new Date(row?.['expires_at'] as Date).getTime() - new Date(row?.['sent_at'] as Date).getTime()) / 3_600_000;
    expect(Math.round(hours)).toBe(72);

    const before = await detail(document.id);
    expect(before.currentTurn).toMatchObject({ order: 1, channel: 'EMAIL_LINK', blockedBy: null });
    expect(before.signatures[0].signingLink).toMatchObject({ status: 'SENT', email: sent?.to, identityAttempts: 0 });
    expect(before.viewer).toMatchObject({ canResendLink: true, canReassign: true });
    expect(JSON.stringify(before)).not.toContain(token);

    // Página pública: metadatos mínimos y nombre enmascarado; nunca el documento de identidad.
    const page = await view(token).expect(200);
    expect(page.body.data).toEqual({
      status: 'ACTIVE',
      expiresAt: expect.any(String),
      consumedAction: null,
      identityAttemptsRemaining: 5,
      document: { sgcCode: 'OCI-01-55', formatName: 'Acta de entrega y asignación de activos fijos', number: document.number },
      turn: { order: 1, roleLabel: 'Recibe' },
      signerName: 'Laura S. U.',
    });
    expect(JSON.stringify(page.body)).not.toContain(documentNumber);
    const pdf = await http()
      .get(`/api/v1/public/signing-links/${token}/pdf`)
      .set('X-Forwarded-For', ip())
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });
    expect(pdf.status).toBe(200);
    expect(pdf.header['content-type']).toBe('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

    // Sin confirmar identidad no firma.
    const unconfirmed = await signByLink(token, 'A'.repeat(43));
    expect([unconfirmed.status, unconfirmed.body.error.code]).toEqual([403, 'SIGNATURE_IDENTITY_REQUIRED']);
    const identityToken = await confirmedToken(token, documentNumber);
    const signed = await signByLink(token, identityToken, '198.51.100.250');
    expect(signed.status).toBe(200);
    expect(signed.body.data).toEqual({ action: 'SIGNED', at: expect.any(String), verificationUrl: expect.any(String) });

    // Un solo uso.
    const reused = await signByLink(token, identityToken);
    expect([reused.status, reused.body.error.code]).toEqual([410, 'SIGNATURE_LINK_UNAVAILABLE']);
    expect((await view(token)).body.data).toMatchObject({ status: 'CONSUMED', consumedAction: 'SIGNED', document: null });

    // Control Interno firma con sesión y MFA.
    await signBySession(document.id, 2, auditor).expect(200);
    const after = await detail(document.id);
    expect(after.status).toBe('SIGNED');
    expect(after.signatures.map((item: { method: string; methodLabel: string }) => [item.method, item.methodLabel])).toEqual([
      ['EMAIL_LINK', 'Enlace de un solo uso enviado al correo institucional'],
      ['SESSION_MFA', 'Sesión con verificación en dos pasos'],
    ]);
    expect(after.signatures[0].signingLink).toMatchObject({ status: 'CONSUMED', consumedAction: 'SIGNED', identityConfirmedAt: expect.any(String) });

    const attestation = (await http().get(`/api/v1/public/signatures/${after.verification.code}`).expect(200)).body.data;
    expect(attestation.status).toBe('COMPLETED');
    expect(attestation.signers.map((item: { method: string; methodLabel: string }) => [item.method, item.methodLabel])).toEqual([
      ['EMAIL_LINK', 'Enlace de un solo uso enviado al correo institucional'],
      ['SESSION_MFA', 'Sesión con verificación en dos pasos'],
    ]);

    // Evidencia en BD según el método.
    const evidence = (await dataSource.query(
      `SELECT s.sign_order, s.method, s.signer_user_id, s.session_id, s.signing_link_id, s.link_email, s.link_sent_at,
              s.identity_confirmed_at, host(s.ip_address) AS ip, s.user_agent
       FROM signature_envelope_signer s JOIN signature_envelope e ON e.id = s.envelope_id
       WHERE e.document_id = $1 ORDER BY s.sign_order`,
      [document.id],
    )) as Array<Record<string, unknown>>;
    expect(evidence[0]).toMatchObject({
      method: 'EMAIL_LINK',
      signer_user_id: null,
      session_id: null,
      signing_link_id: row?.['id'],
      link_email: sent?.to,
      ip: '198.51.100.250',
      user_agent: 'vitest-enlace',
    });
    expect(evidence[0]?.['link_sent_at']).not.toBeNull();
    expect(evidence[0]?.['identity_confirmed_at']).not.toBeNull();
    expect(evidence[1]).toMatchObject({ method: 'SESSION_MFA', signer_user_id: auditor.userId, session_id: auditor.sessionId });

    // El PDF firmado dice el método de cada firmante.
    const signedText = squash(await pdfText((await engine.download(document.id, 'pdf', director.userId)).body));
    expect(signedText).toContain('Método: Enlace de un solo uso enviado al correo');
    expect(signedText).toContain('Método: Sesión con verificación en dos pasos');

    // El CHECK de evidencia depende del método: una firma por enlace sin identidad confirmada no entra.
    await expect(
      dataSource.query(
        `UPDATE signature_envelope_signer SET identity_confirmed_at = NULL
         WHERE envelope_id = (SELECT id FROM signature_envelope WHERE document_id = $1) AND sign_order = 1`,
        [document.id],
      ),
    ).rejects.toThrow(/chk_signature_envelope_signer_evidence/);

    // El token nunca aparece en logs ni en audit_log.
    expect(output).not.toContain(token);
    expect(output).not.toContain(identityToken);
    expect(
      await scalar<number>(dataSource, `SELECT count(*)::int FROM audit_log a WHERE row_to_json(a)::text LIKE '%' || $1 || '%'`, [token]),
    ).toBe(0);
    expect(
      await scalar<number>(
        dataSource,
        `SELECT count(*)::int FROM audit_log a WHERE row_to_json(a)::text LIKE '%' || $1 || '%'`,
        [documentNumber],
      ),
    ).toBe(0);
  });

  it('identidad incorrecta 5 veces invalida el enlace; reenviar invalida el anterior; vence a las 72 h', async () => {
    const documentNumber = docNumber();
    const personId = await outsider('Mario', documentNumber);
    const document = await generate(personId);
    const first = lastToken();
    const wrong = documentNumber.slice(-4) === '0000' ? '1111' : '0000';
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const response = await identity(first, wrong);
      expect([response.status, response.body.error.code]).toEqual([403, 'SIGNATURE_IDENTITY_MISMATCH']);
      expect(response.body.error.details).toEqual([{ field: 'last4', message: `Quedan ${5 - attempt} intentos` }]);
    }
    const locked = await identity(first, wrong);
    expect([locked.status, locked.body.error.code]).toEqual([410, 'SIGNATURE_IDENTITY_LOCKED']);
    // Ni con los dígitos correctos: hay que reenviar.
    expect((await identity(first, documentNumber.slice(-4))).body.error.code).toBe('SIGNATURE_LINK_UNAVAILABLE');
    expect((await view(first)).body.data).toMatchObject({ status: 'INVALIDATED', document: null, turn: null, signerName: null });
    expect((await detail(document.id)).signatures[0].signingLink).toMatchObject({
      status: 'INVALIDATED',
      invalidatedReason: 'ATTEMPTS_EXCEEDED',
      identityAttempts: 5,
    });

    // Solo quien administra el proceso reenvía.
    const stranger = await user('Ajeno', true, docNumber());
    const denied = await http()
      .post(`/api/v1/documents/${document.id}/signatures/1/signing-link`)
      .set('Authorization', `Bearer ${stranger.token}`);
    expect([denied.status, denied.body.error.code]).toEqual([403, 'INSUFFICIENT_PERMISSIONS']);
    const notLinkTurn = await http()
      .post(`/api/v1/documents/${document.id}/signatures/2/signing-link`)
      .set('Authorization', `Bearer ${director.token}`);
    expect(notLinkTurn.body.error.code).toBe('SIGNATURE_LINK_NOT_APPLICABLE');

    const resent = await http()
      .post(`/api/v1/documents/${document.id}/signatures/1/signing-link`)
      .set('Authorization', `Bearer ${director.token}`)
      .expect(200);
    const second = lastToken();
    expect(second).not.toBe(first);
    expect(resent.body.data.signatures[0].signingLink).toMatchObject({ status: 'SENT', identityAttempts: 0 });
    expect(JSON.stringify(resent.body)).not.toContain(second);

    // Reenviar otra vez invalida el segundo (RESENT).
    await http()
      .post(`/api/v1/documents/${document.id}/signatures/1/signing-link`)
      .set('Authorization', `Bearer ${director.token}`)
      .expect(200);
    const third = lastToken();
    expect((await view(second)).body.data.status).toBe('INVALIDATED');
    expect(
      await scalar<string>(dataSource, 'SELECT invalidated_reason FROM signature_signing_link WHERE token_hash = encode(sha256($1::bytea), $2)', [
        second,
        'hex',
      ]),
    ).toBe('RESENT');

    // Vence a las 72 h: se simula el paso del tiempo.
    await dataSource.query(
      `UPDATE signature_signing_link SET expires_at = NOW() - interval '1 minute' WHERE token_hash = encode(sha256($1::bytea), 'hex')`,
      [third],
    );
    expect((await view(third)).body.data).toMatchObject({ status: 'EXPIRED', document: null });
    expect((await identity(third, documentNumber.slice(-4))).body.error.code).toBe('SIGNATURE_LINK_UNAVAILABLE');
    expect((await detail(document.id)).signatures[0].signingLink.status).toBe('EXPIRED');
    const notFound = await view('B'.repeat(43));
    expect([notFound.status, notFound.body.error.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
    expect((await view('corto')).status).toBe(400);
  });

  it('sin SMTP el envío queda FALLIDO y visible, sin tumbar el acta; persona sin documento: turno bloqueado sin enlace', async () => {
    smtpUp = false;
    try {
      const personId = await outsider('Nora', docNumber());
      const document = await generate(personId);
      expect(document.status).toBe('PENDING_SIGNATURE');
      const link = (await detail(document.id)).signatures[0].signingLink;
      expect(link).toMatchObject({
        status: 'SEND_FAILED',
        sendAttempts: 1,
        lastSendError: 'El correo saliente (SMTP) no está configurado o está deshabilitado',
        sentAt: null,
      });
    } finally {
      smtpUp = true;
    }

    const noDocument = await outsider('Olga', null);
    const blocked = await generate(noDocument);
    const blockedDetail = await detail(blocked.id);
    expect(blockedDetail.currentTurn).toMatchObject({ order: 1, channel: null, blockedBy: 'SIGNATURE_NO_IDENTITY_CHECK' });
    expect(blockedDetail.signatures[0].signingLink).toBeNull();
    expect(await scalar<number>(dataSource, 'SELECT count(*)::int FROM signature_signing_link WHERE document_id = $1', [blocked.id])).toBe(0);
    const resend = await http()
      .post(`/api/v1/documents/${blocked.id}/signatures/1/signing-link`)
      .set('Authorization', `Bearer ${director.token}`);
    expect([resend.status, resend.body.error.code]).toEqual([409, 'SIGNATURE_NO_IDENTITY_CHECK']);
  });

  it('usuario sin MFA firma un turno que no es de Control Interno como SESSION', async () => {
    const plain = await user('Pedro', false, docNumber());
    const document = await generate(plain.personId);
    expect((await detail(document.id)).currentTurn).toMatchObject({ channel: 'SESSION', blockedBy: null });
    const signed = await signBySession(document.id, 1, plain).expect(200);
    expect(signed.body.data.signatures[0]).toMatchObject({ method: 'SESSION', methodLabel: 'Sesión' });
    expect(await scalar<number>(dataSource, 'SELECT count(*)::int FROM signature_signing_link WHERE document_id = $1', [document.id])).toBe(0);
  });

  it('si el proceso falla al cerrar el acta, la verificación pública no dice COMPLETED; el lifecycleError sale en la lista', async () => {
    const plain = await user('Rosa', false, docNumber());
    const document = await generate(plain.personId, { entityType: ENTITY, entityId: randomUUID() });
    lifecycleFailures.onSigned = 1;
    await signBySession(document.id, 1, plain).expect(200);
    const stalled = (await signBySession(document.id, 2, auditor).expect(200)).body.data;
    expect(stalled).toMatchObject({ status: 'PENDING_SIGNATURE', lifecycleError: `${ENTITY}.onSigned: fallo simulado del proceso al cerrar el acta` });
    const code = stalled.verification.code as string;
    expect((await http().get(`/api/v1/public/signatures/${code}`)).body.data.status).toBe('SIGNATURES_COLLECTED');

    const list = await http()
      .get('/api/v1/documents')
      .query({ formatKey: FORMAT, pageSize: 100 })
      .set('Authorization', `Bearer ${director.token}`)
      .expect(200);
    const item = (list.body.data.items as Array<{ documentId: string; lifecycleError: string | null }>).find(
      (entry) => entry.documentId === document.id,
    );
    expect(item?.lifecycleError).toBe(`${ENTITY}.onSigned: fallo simulado del proceso al cerrar el acta`);

    await engine.retryLifecycle(1000);
    expect((await http().get(`/api/v1/public/signatures/${code}`)).body.data.status).toBe('COMPLETED');
  });

  it('un fallo al guardar el PDF firmado se reintenta en el job', async () => {
    const plain = await user('Sara', false, docNumber());
    const document = await generate(plain.personId);
    await signBySession(document.id, 1, plain).expect(200);
    const storage = app.get(StorageService);
    const put = storage.put.bind(storage);
    const spy = vi.spyOn(storage, 'put').mockImplementation((input) =>
      input.key.endsWith('-firmado.pdf') ? Promise.reject(new Error('almacenamiento caído')) : put(input),
    );
    try {
      const signed = (await signBySession(document.id, 2, auditor).expect(200)).body.data;
      expect(signed).toMatchObject({ status: 'SIGNED', signedPdfSha256: null });
    } finally {
      spy.mockRestore();
    }
    const retried = await engine.retrySignedPdfs(1000);
    expect(retried.retried).toBeGreaterThanOrEqual(1);
    expect((await detail(document.id)).signedPdfSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('el reintento reinicia attempts y el acta lleva la fecha de la solicitud, no la del reintento', async () => {
    const plain = await user('Teresa', false, docNumber());
    const createdAt = new Date(Date.now() - 6 * 24 * 3_600_000);
    const requestId = await scalar<string>(
      dataSource,
      `INSERT INTO document_request (format_key, payload, status, attempts, last_error, requested_by, created_at)
       VALUES ($1, $2, 'FAILED', 5, 'fallo de prueba', $3, $4) RETURNING id`,
      [FORMAT, JSON.stringify({ formatKey: FORMAT, responsiblePersonId: plain.personId, signers: { AUDITA: auditor.personId } }), director.userId, createdAt],
    );
    const retried = await http()
      .post(`/api/v1/documents/requests/${requestId}/retry`)
      .set('Authorization', `Bearer ${director.token}`)
      .expect(200);
    expect(retried.body.data).toMatchObject({ status: 'PENDING_GENERATION', attempts: 0 });
    await engine.processPending(1000);
    const [row] = (await dataSource.query(
      `SELECT r.status, r.attempts, d.data->'documento'->>'fecha' AS fecha
       FROM document_request r JOIN document d ON d.id = r.document_id WHERE r.id = $1`,
      [requestId],
    )) as Array<{ status: string; attempts: number; fecha: string }>;
    expect(row).toEqual({ status: 'GENERATED', attempts: 1, fecha: longDate(createdAt) });
    expect(row?.fecha).not.toBe(longDate(new Date()));
  });

  it('voidForEntity cancela solicitudes, anula actas pendientes, cierra el sobre e invalida enlaces; un acta firmada no se anula', async () => {
    const entityId = randomUUID();
    const documentNumber = docNumber();
    const personId = await outsider('Ursula', documentNumber);
    const document = await generate(personId, { entityType: ENTITY, entityId });
    const token = lastToken();
    const pendingRequest = await dataSource.transaction((manager) =>
      engine.enqueue(manager, { formatKey: FORMAT, entityType: ENTITY, entityId, responsiblePersonId: personId, signers: { AUDITA: auditor.personId } }, null),
    );

    const result = await dataSource.transaction((manager) =>
      engine.voidForEntity(manager, { entityType: ENTITY, entityId, reason: 'La entrega se canceló', actorId: director.userId }),
    );
    expect(result).toEqual({ cancelledRequestIds: [pendingRequest], voidedDocumentIds: [document.id] });
    await engine.processPending(1000);
    expect(await scalar<string>(dataSource, 'SELECT status FROM document_request WHERE id = $1', [pendingRequest])).toBe('CANCELLED');
    expect(await scalar<string | null>(dataSource, 'SELECT document_id FROM document_request WHERE id = $1', [pendingRequest])).toBeNull();

    const voided = await detail(document.id);
    expect(voided).toMatchObject({
      status: 'VOIDED',
      currentTurn: null,
      voidReason: 'La entrega se canceló',
      voidedBy: director.userId,
      voidedAt: expect.any(String),
    });
    expect(voided.viewer).toMatchObject({ canReassign: false, canResendLink: false });
    expect(voided.signatures[0].signingLink).toMatchObject({ status: 'INVALIDATED', invalidatedReason: 'VOIDED' });
    expect((await view(token)).body.data.status).toBe('INVALIDATED');
    expect((await identity(token, documentNumber.slice(-4))).body.error.code).toBe('SIGNATURE_LINK_UNAVAILABLE');
    expect((await signBySession(document.id, 2, auditor)).body.error.code).toBe('INVALID_STATE');
    expect((await http().get(`/api/v1/public/signatures/${voided.verification.code}`)).body.data.status).toBe('VOIDED');
    expect(await scalar<string>(dataSource, 'SELECT status FROM signature_envelope WHERE document_id = $1', [document.id])).toBe('VOIDED');

    const list = await http()
      .get('/api/v1/documents')
      .query({ formatKey: FORMAT, pageSize: 100 })
      .set('Authorization', `Bearer ${director.token}`)
      .expect(200);
    const items = list.body.data.items as Array<{ id: string; status: string; error: string | null }>;
    expect(items.find((item) => item.id === document.id)?.status).toBe('VOIDED');
    expect(items.find((item) => item.id === pendingRequest)).toMatchObject({ status: 'CANCELLED', error: 'La entrega se canceló' });

    // Un acta ya firmada no se anula: error explícito y la transacción del proceso se revierte.
    const signedEntity = randomUUID();
    const plain = await user('Valeria', false, docNumber());
    const signedDoc = await generate(plain.personId, { entityType: ENTITY, entityId: signedEntity });
    await signBySession(signedDoc.id, 1, plain).expect(200);
    await signBySession(signedDoc.id, 2, auditor).expect(200);
    await expect(
      dataSource.transaction((manager) =>
        engine.voidForEntity(manager, { entityType: ENTITY, entityId: signedEntity, reason: 'Tarde', actorId: null }),
      ),
    ).rejects.toMatchObject({ code: 'DOCUMENT_ALREADY_SIGNED' });
    expect((await detail(signedDoc.id)).status).toBe('SIGNED');
  });
});
