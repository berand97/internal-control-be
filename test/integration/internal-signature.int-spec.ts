import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import QRCode from 'qrcode';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { AppModule } from '../../src/app.module.js';
import { applyTrustProxy } from '../../src/common/http/trust-proxy.js';
import type { AppConfig } from '../../src/config/configuration.js';
import { createAppValidationPipe } from '../../src/common/pipes/app-validation.pipe.js';
import { TokenService } from '../../src/modules/auth/services/token.service.js';
import { GotenbergPdfConverter, PDF_CONVERTER, type PdfConverter } from '../../src/modules/documents/pdf/pdf-converter.js';
import { DocumentEngineService } from '../../src/modules/documents/services/document-engine.service.js';
import { prepareForSignature, stampSignature } from '../../src/modules/documents/signature/pdf-stamp.js';
import { createActor, scalar, useSharedStorage } from './helpers.js';

const TEMPLATE = 'templates/formats/OCI-01-55-v2.docx';
const SECRET_DESCRIPTION = 'MICROSCOPIO CONFIDENCIAL XK-99';
const SECRET_CENTER = 'Laboratorio Reservado de Firmas';

class TestPdfConverter implements PdfConverter {
  async toPdf(docx: Buffer): Promise<Buffer> {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([612, 792]);
    page.drawText(`Acta de prueba ${SECRET_DESCRIPTION} (${docx.length} bytes)`, { x: 50, y: 700, size: 10, font });
    return Buffer.from(await pdf.save());
  }
}

const sha256 = (content: Buffer): string => createHash('sha256').update(content).digest('hex');

interface Signer {
  userId: string;
  personId: string;
  sessionId: string;
  token: string;
}

describe('Firma electrónica simple con el proveedor interno (HTTP real + PostgreSQL real)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let engine: DocumentEngineService;
  let tokens: TokenService;
  let storageDir: string;
  let directorId: string;
  let costCenterId: string;
  let assetId: string;
  let responsible: Signer;
  let auditor: Signer;
  let outsider: Signer;
  let rubric: string;

  const http = () => request(app.getHttpServer());

  const signer = async (first: string, last: string, documentNumber: string): Promise<Signer> => {
    const tag = randomUUID().slice(0, 8);
    const personId = await scalar<string>(
      dataSource,
      `INSERT INTO person (first_name, last_name, email, document_type, document_number)
       VALUES ($1, $2, $3, 'CC', $4) RETURNING id`,
      [first, last, `firma.${tag}@unac.edu.co`, documentNumber],
    );
    const userId = await scalar<string>(
      dataSource,
      `INSERT INTO app_user (person_id, username, password_hash, mfa_enabled, status)
       VALUES ($1, $2, 'x', TRUE, 'ACTIVE') RETURNING id`,
      [personId, `firma.${tag}`],
    );
    const sessionId = randomUUID();
    await dataSource.query(
      `INSERT INTO refresh_token_family (id, user_id, current_jti, expires_at) VALUES ($1, $2, $3, NOW() + interval '1 day')`,
      [sessionId, userId, randomUUID()],
    );
    const token = tokens.signAccessToken({
      id: userId,
      personId,
      username: `firma.${tag}`,
      roles: [],
      scopes: [],
      mustChangePassword: false,
      sessionId,
    });
    return { userId, personId, sessionId, token };
  };

  const generate = () =>
    engine.generate(
      {
        formatKey: 'OCI-17-90-BAJA',
        costCenterId,
        responsiblePersonId: responsible.personId,
        assetIds: [assetId],
        signers: { AUDITA: auditor.personId },
      },
      directorId,
    );

  const sign = (documentId: string, order: number, who: Signer) =>
    http()
      .post(`/api/v1/documents/${documentId}/signatures/${order}`)
      .set('Authorization', `Bearer ${who.token}`)
      .set('User-Agent', 'vitest-firma')
      .set('X-Forwarded-For', '203.0.113.50')
      .send({ rubric });

  const envelopeOf = async (documentId: string) => {
    const [row] = (await dataSource.query('SELECT * FROM signature_envelope WHERE document_id = $1', [documentId])) as Array<{
      id: string;
      verification_code: string;
      current_pdf_key: string;
      current_pdf_sha256: string;
    }>;
    if (!row) {
      throw new Error('sin solicitud de firma');
    }
    return row;
  };

  const verify = (code: string) => http().get(`/api/v1/public/signatures/${code}`);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PDF_CONVERTER)
      .useValue(new TestPdfConverter())
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    applyTrustProxy(app, app.get(ConfigService<AppConfig, true>).getOrThrow('trustProxy', { infer: true }));
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
    dataSource = app.get(DataSource);
    engine = app.get(DocumentEngineService);
    tokens = app.get(TokenService);
    storageDir = await useSharedStorage(dataSource);

    const director = await createActor(dataSource);
    directorId = director.id;
    await dataSource.query(
      `INSERT INTO user_role (user_id, role_id, scope_type) SELECT $1, id, 'GLOBAL' FROM role WHERE code = 'INTERNAL_CONTROL_DIRECTOR'`,
      [directorId],
    );
    costCenterId = await scalar<string>(
      dataSource,
      `INSERT INTO cost_center (external_code, name) VALUES ('FIRMA-1', $1) RETURNING id`,
      [SECRET_CENTER],
    );
    const categoryId = await scalar<string>(
      dataSource,
      `INSERT INTO asset_category (code, name, requires_photo) VALUES ('FIRMA', 'Firmas', FALSE) RETURNING id`,
    );
    assetId = await scalar<string>(
      dataSource,
      `INSERT INTO asset (internal_code, description, category_id, acquisition_type_id, acquisition_date,
         current_cost_center_id, created_by, physical_condition)
       VALUES ('FIRMA-0001', $1, $2, (SELECT id FROM acquisition_type WHERE code = 'PURCHASE'), '2020-01-01', $3, $4, 'GOOD')
       RETURNING id`,
      [SECRET_DESCRIPTION, categoryId, costCenterId, directorId],
    );
    responsible = await signer('Responsable', 'Firma', '1000000501');
    auditor = await signer('Auditora', 'Firma', '1000000502');
    outsider = await signer('Ajeno', 'Firma', '1000000503');
    rubric = `data:image/png;base64,${(await QRCode.toBuffer('rubrica de prueba', { width: 180 })).toString('base64')}`;

    await engine.uploadTemplate(
      'OCI-17-90-BAJA',
      { buffer: await readFile(TEMPLATE), originalname: 'plantilla.docx' },
      { sgcVersion: '1', effectiveDate: '2026-02-01' },
      directorId,
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('firma un documento generado en el orden configurado y la página pública lo atestigua', async () => {
    const document = await generate();
    const envelope = await envelopeOf(document.id);
    expect(envelope.verification_code).toMatch(/^[A-Za-z0-9_-]{32}$/);

    const early = await sign(document.id, 2, auditor);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('SIGNATURE_OUT_OF_ORDER');
    const impostor = await sign(document.id, 1, outsider);
    expect(impostor.status).toBe(403);
    expect(impostor.body.error.code).toBe('SIGNATURE_NOT_DESIGNATED_SIGNER');
    expect((await http().post(`/api/v1/documents/${document.id}/signatures/1`).send({ rubric })).status).toBe(401);

    const first = await sign(document.id, 1, responsible);
    expect(first.status).toBe(200);
    expect(first.body.data.status).toBe('PENDING_SIGNATURE');
    const partial = await verify(envelope.verification_code);
    expect(partial.body.data).toMatchObject({ status: 'PENDING', integrity: 'INTACT' });
    expect(partial.body.data.signers.map((item: { status: string; name: string | null }) => [item.status, item.name])).toEqual([
      ['SIGNED', 'Responsable Firma'],
      ['PENDING', null],
    ]);

    const second = await sign(document.id, 2, auditor);
    expect(second.status).toBe(200);
    expect(second.body.data.status).toBe('SIGNED');
    expect(second.body.data.signatures.map((item: { status: string }) => item.status)).toEqual(['SIGNED', 'SIGNED']);

    const attestation = (await verify(envelope.verification_code)).body.data;
    expect(attestation).toMatchObject({ reference: envelope.verification_code, status: 'COMPLETED', integrity: 'INTACT' });
    expect(attestation.signers).toEqual([
      { order: 1, role: 'Responsable', name: 'Responsable Firma', status: 'SIGNED', signedAt: expect.any(String) },
      { order: 2, role: 'Control Interno', name: 'Auditora Firma', status: 'SIGNED', signedAt: expect.any(String) },
    ]);

    const evidence = (await dataSource.query(
      `SELECT sign_order, signer_user_id, session_id, host(ip_address) AS ip, user_agent, mfa_enabled,
         pdf_sha256_before, pdf_sha256_after, rubric_sha256
       FROM signature_envelope_signer s JOIN signature_envelope e ON e.id = s.envelope_id
       WHERE e.document_id = $1 ORDER BY sign_order`,
      [document.id],
    )) as Array<Record<string, string | boolean>>;
    expect(evidence[0]).toMatchObject({ signer_user_id: responsible.userId, session_id: responsible.sessionId, user_agent: 'vitest-firma', mfa_enabled: true });
    expect(evidence[1]).toMatchObject({ signer_user_id: auditor.userId, session_id: auditor.sessionId });
    expect(evidence.map((item) => item['ip'])).toEqual(['203.0.113.50', '203.0.113.50']);
    expect(evidence[1]?.['pdf_sha256_before']).toBe(evidence[0]?.['pdf_sha256_after']);

    const original = await engine.download(document.id, 'docx', directorId);
    expect(original.fileName).toMatch(/\.docx$/);
    const signed = await engine.download(document.id, 'pdf', directorId);
    expect(signed.fileName).toMatch(/-firmado\.pdf$/);
    const [row] = (await dataSource.query('SELECT pdf_key, pdf_hash, signed_pdf_hash FROM document WHERE id = $1', [document.id])) as Array<{
      pdf_key: string;
      pdf_hash: string;
      signed_pdf_hash: string;
    }>;
    expect(sha256(signed.body)).toBe(row?.signed_pdf_hash);
    expect(row?.signed_pdf_hash).toBe(evidence[1]?.['pdf_sha256_after']);
    const unsigned = await readFile(join(storageDir, row?.pdf_key ?? ''));
    expect(sha256(unsigned)).toBe(row?.pdf_hash);
    const pages = async (pdf: Buffer) => (await PDFDocument.load(pdf)).getPageCount();
    expect(await pages(signed.body)).toBe((await pages(unsigned)) + 1);
  });

  it('alterar el PDF almacenado hace fallar la verificación y bloquea nuevas firmas', async () => {
    const signedDoc = await generate();
    await sign(signedDoc.id, 1, responsible).expect(200);
    await sign(signedDoc.id, 2, auditor).expect(200);
    const signedEnvelope = await envelopeOf(signedDoc.id);
    const path = join(storageDir, signedEnvelope.current_pdf_key);
    const content = await readFile(path);
    await writeFile(path, Buffer.concat([content, Buffer.from('\n% alterado')]));
    const altered = await verify(signedEnvelope.verification_code);
    expect(altered.status).toBe(200);
    expect(altered.body.data).toMatchObject({ status: 'COMPLETED', integrity: 'ALTERED' });

    const pendingDoc = await generate();
    const pendingEnvelope = await envelopeOf(pendingDoc.id);
    await writeFile(join(storageDir, pendingEnvelope.current_pdf_key), Buffer.from('%PDF-1.7 reemplazado'));
    const blocked = await sign(pendingDoc.id, 1, responsible);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('DOCUMENT_TAMPERED');
    expect((await verify(pendingEnvelope.verification_code)).body.data.integrity).toBe('ALTERED');
  });

  it('no deja firmar sin MFA ni con la sesión revocada', async () => {
    const document = await generate();
    await dataSource.query('UPDATE app_user SET mfa_enabled = FALSE WHERE id = $1', [responsible.userId]);
    const withoutMfa = await sign(document.id, 1, responsible);
    expect(withoutMfa.status).toBe(403);
    expect(withoutMfa.body.error.code).toBe('SIGNATURE_MFA_REQUIRED');
    await dataSource.query('UPDATE app_user SET mfa_enabled = TRUE WHERE id = $1', [responsible.userId]);

    await dataSource.query(`UPDATE refresh_token_family SET status = 'REVOKED', revoked_at = NOW() WHERE id = $1`, [
      responsible.sessionId,
    ]);
    const revoked = await sign(document.id, 1, responsible);
    expect(revoked.status).toBe(403);
    expect(revoked.body.error.code).toBe('SIGNATURE_SESSION_INVALID');
    await dataSource.query(`UPDATE refresh_token_family SET status = 'ACTIVE', revoked_at = NULL WHERE id = $1`, [
      responsible.sessionId,
    ]);
    await sign(document.id, 1, responsible).expect(200);
  });

  it('la página pública no expone el contenido del documento ni permite enumerar', async () => {
    const document = await generate();
    await sign(document.id, 1, responsible).expect(200);
    const envelope = await envelopeOf(document.id);
    const response = await verify(envelope.verification_code);
    expect(response.status).toBe(200);
    const data = response.body.data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(['checkedAt', 'documentSha256', 'integrity', 'reference', 'signers', 'status']);
    for (const signerItem of data['signers'] as Array<Record<string, unknown>>) {
      expect(Object.keys(signerItem).sort()).toEqual(['name', 'order', 'role', 'signedAt', 'status']);
    }
    const text = JSON.stringify(response.body);
    for (const secret of [
      document.id,
      document.number,
      'OCI-17-90',
      SECRET_DESCRIPTION,
      SECRET_CENTER,
      'FIRMA-1',
      'FIRMA-0001',
      assetId,
      '1000000501',
      '1000000502',
      responsible.personId,
      responsible.userId,
      responsible.sessionId,
    ]) {
      expect(text).not.toContain(secret);
    }

    expect((await verify('A'.repeat(32))).status).toBe(404);
    expect((await verify('1')).status).toBe(400);
    expect((await verify(document.id)).status).toBe(404);
  });
});

describe.runIf(Boolean(process.env['GOTENBERG_URL']))('Estampado de firma sobre un PDF real de LibreOffice', () => {
  it('prepara y estampa el PDF que produce Gotenberg sin romperlo', async () => {
    const config = { getOrThrow: () => ({ gotenbergUrl: process.env['GOTENBERG_URL'] }) } as unknown as ConstructorParameters<
      typeof GotenbergPdfConverter
    >[0];
    const pdf = await new GotenbergPdfConverter(config).toPdf(await readFile(TEMPLATE), 'OCI-01-55-v2.docx');
    const originalPages = (await PDFDocument.load(pdf)).getPageCount();
    const prepared = await prepareForSignature(pdf, {
      title: 'OCI-01-55 · prueba',
      verifyUrl: 'https://example.invalid/verificar-firma/codigo',
      verificationCode: 'codigo',
      originalSha256: sha256(pdf),
      slots: [
        { order: 1, label: 'Recibe' },
        { order: 2, label: 'Control Interno' },
      ],
    });
    const rubricPng = await QRCode.toBuffer('rubrica', { width: 180 });
    let signed = prepared;
    for (const slotIndex of [0, 1]) {
      signed = await stampSignature(signed, {
        slotIndex,
        rubricPng,
        label: 'Firmante',
        name: 'Nombre Con Tildes Ñandú',
        documentNumber: '1000000001',
        signedAt: new Date(),
        ipAddress: '10.0.0.1',
      });
    }
    expect((await PDFDocument.load(signed)).getPageCount()).toBe(originalPages + 1);
  });
});
