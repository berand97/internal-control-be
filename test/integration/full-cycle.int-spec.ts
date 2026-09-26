import type { NestExpressApplication } from '@nestjs/platform-express';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { PDFDocument } from 'pdf-lib';
import QRCode from 'qrcode';
import request from 'supertest';
import { findLeftovers, OCI_01_55_SAMPLE } from '../../scripts/formats/template-leftovers.mjs';
import { pdfText, sampleLeftovers, squash } from './pdf-text.js';
import { DataSource } from 'typeorm';

const GOTENBERG = process.env['GOTENBERG_URL'];
const OUTPUT = process.env['E2E_OUTPUT_DIR'] ?? join(tmpdir(), 'control-interno-e2e');
const E2E_DB = 'control_interno_e2e';
const ADMIN_URL = process.env['TEST_DATABASE_ADMIN_URL'] ?? 'postgres://postgres:postgres@localhost:5432/postgres';
const TEMPLATE = 'templates/formats/OCI-01-55-v2.docx';
const STORAGE = join(tmpdir(), 'control-interno-e2e-storage');

const ASSET_HEADER = ['MovIdActivo', 'MovCodBarras', 'MovDescripción', 'MovModelo', 'MovNumDocumento', 'MovNumSerie', 'MovIdCuenta', 'MovIdCentro', 'MovFechaCompra', 'MovDebaja', 'MovFechaDebaja', 'MovAñoDepre', '#', 'MovObservaciones', 'MovDep2000', 'MovDep2001', 'MovDepAñoAnterior', 'MovDepAño', 'MovDepAcumulada', 'MovDepMensual', 'MovPrecioCompra', 'MovActivoMenor', 'F21'];
const REAL_ASSET_ROW = [15796, '01979', 'Sillas Interlocutoras/verdes', null, null, null, 2, 4360, new Date('1997-09-14T00:00:00Z'), false, null, 5, 1, null, 0, null, 46400, 0, 46400, 0, 46400, false, false];
const REAL_CENTER = [4360, 'DEPARTAMENTO DE FINANZAS ESTUDIANTILES'];

const sha256 = (content: Buffer): string => createHash('sha256').update(content).digest('hex');

const workbook = async (sheet: string, rows: ReadonlyArray<ReadonlyArray<unknown>>): Promise<Buffer> => {
  const book = new ExcelJS.Workbook();
  const ws = book.addWorksheet(sheet);
  rows.forEach((values, index) => {
    const row = ws.getRow(index + 1);
    values.forEach((value, column) => {
      if (value !== null && value !== undefined) {
        row.getCell(column + 1).value = value as ExcelJS.CellValue;
      }
    });
    row.commit();
  });
  return Buffer.from(await book.xlsx.writeBuffer());
};

const admin = async (sql: string): Promise<void> => {
  const connection = new DataSource({ type: 'postgres', url: ADMIN_URL });
  await connection.initialize();
  try {
    await connection.query(sql);
  } finally {
    await connection.destroy();
  }
};

interface User {
  userId: string;
  personId: string;
  token: string;
}

describe.runIf(Boolean(GOTENBERG)).sequential('Ciclo completo: plantilla → acta → PDF → firmas → verificación pública', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  const log: Array<{ step: string; ok: boolean; detail: Record<string, unknown> }> = [];
  const state: {
    director?: User;
    responsible?: User;
    auditor?: User;
    assetId?: string | undefined;
    costCenterId?: string | undefined;
    documentId?: string | undefined;
    verificationCode?: string | undefined;
  } = {};

  const http = () => request(app.getHttpServer());
  const auth = (user: User | undefined) => `Bearer ${user?.token ?? ''}`;
  const record = (step: string, ok: boolean, detail: Record<string, unknown>) => {
    log.push({ step, ok, detail });
    console.log(`[E2E] ${ok ? 'OK ' : 'FALLA'} ${step} ${JSON.stringify(detail)}`);
  };

  beforeAll(async () => {
    await rm(OUTPUT, { recursive: true, force: true });
    await mkdir(OUTPUT, { recursive: true });
    await rm(STORAGE, { recursive: true, force: true });
    await mkdir(STORAGE, { recursive: true });
    await admin(`DROP DATABASE IF EXISTS "${E2E_DB}" WITH (FORCE)`);
    await admin(`CREATE DATABASE "${E2E_DB}"`);
    const url = new URL(ADMIN_URL);
    url.pathname = `/${E2E_DB}`;
    process.env['DATABASE_URL'] = url.toString();
    process.env['GOTENBERG_URL'] = GOTENBERG;

    const { default: migrations } = await import('../../src/database/data-source.js');
    await migrations.initialize();
    await migrations.runMigrations({ transaction: 'each' });
    await migrations.destroy();

    const { Test } = await import('@nestjs/testing');
    const { ConfigService } = await import('@nestjs/config');
    const { AppModule } = await import('../../src/app.module.js');
    const { applyTrustProxy } = await import('../../src/common/http/trust-proxy.js');
    const { createAppValidationPipe } = await import('../../src/common/pipes/app-validation.pipe.js');
    const { TokenService } = await import('../../src/modules/auth/services/token.service.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    applyTrustProxy(app, app.get(ConfigService).getOrThrow('trustProxy'));
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
    dataSource = app.get(DataSource);
    await dataSource.query('UPDATE storage_settings SET driver = $1, project_path = $2', ['project', STORAGE]);

    const tokens = app.get(TokenService);
    const user = async (first: string, last: string, documentNumber: string, role: string | null): Promise<User> => {
      const tag = randomUUID().slice(0, 8);
      const [personRow] = (await dataSource.query(
        `INSERT INTO person (first_name, last_name, email, document_type, document_number, position_title)
         VALUES ($1, $2, $3, 'CC', $4, $5) RETURNING id`,
        [first, last, `e2e.${tag}@unac.edu.co`, documentNumber, role ? 'Directora de Control Interno' : 'Coordinadora de Finanzas Estudiantiles'],
      )) as Array<{ id: string }>;
      const personId = personRow?.id ?? '';
      const [userRow] = (await dataSource.query(
        `INSERT INTO app_user (person_id, username, password_hash, mfa_enabled, status) VALUES ($1, $2, 'x', TRUE, 'ACTIVE') RETURNING id`,
        [personId, `e2e.${tag}`],
      )) as Array<{ id: string }>;
      const userId = userRow?.id ?? '';
      if (role) {
        await dataSource.query(
          `INSERT INTO user_role (user_id, role_id, scope_type) SELECT $1, id, 'GLOBAL' FROM role WHERE code = $2`,
          [userId, role],
        );
      }
      const sessionId = randomUUID();
      await dataSource.query(
        `INSERT INTO refresh_token_family (id, user_id, current_jti, expires_at, mfa_verified_at)
       VALUES ($1, $2, $3, NOW() + interval '1 day', (SELECT CASE WHEN mfa_enabled THEN NOW() END FROM app_user WHERE id = $2))`,
        [sessionId, userId, randomUUID()],
      );
      const token = tokens.signAccessToken({ id: userId, personId, username: `e2e.${tag}`, roles: role ? [role] : [], scopes: role ? [{ type: 'GLOBAL', id: null }] : [], mustChangePassword: false, sessionId });
      return { userId, personId, token };
    };
    state.director = await user('Carolina', 'Directora E2E', '1000000901', 'INTERNAL_CONTROL_DIRECTOR');
    state.auditor = state.director;
    state.responsible = await user('Laura', 'Responsable E2E', '1000000902', null);
  }, 300_000);

  afterAll(async () => {
    await writeFile(join(OUTPUT, 'bitacora.json'), JSON.stringify(log, null, 2));
    await app?.close();
    if (process.env['KEEP_TEST_DATABASE'] !== 'true') {
      await admin(`DROP DATABASE IF EXISTS "${E2E_DB}" WITH (FORCE)`);
    }
  });

  it('1. carga la plantilla OCI-01-55 como versión vigente', async () => {
    const upload = await http()
      .post('/api/v1/documents/formats/OCI-01-55/templates')
      .set('Authorization', auth(state.director))
      .field('sgcVersion', '2')
      .field('effectiveDate', '2026-09-08')
      .attach('file', await readFile(TEMPLATE), 'OCI-01-55-v2.docx');
    const formats = await http().get('/api/v1/documents/formats').set('Authorization', auth(state.director));
    const format = (formats.body.data as Array<Record<string, unknown>>)?.find((item) => item['key'] === 'OCI-01-55');
    record('plantilla', upload.status === 201 || upload.status === 200, { upload: upload.status, error: upload.body?.error, format });
    expect([200, 201]).toContain(upload.status);
    expect(format).toBeDefined();
  });

  it('2. importa un activo real por el asistente de Excel', async () => {
    const importSheet = async (file: Buffer, name: string, sheet: string, target: string, mapping: Record<string, string>) => {
      const upload = await http().post('/api/v1/imports').set('Authorization', auth(state.director)).attach('file', file, name);
      const preview = await http()
        .post(`/api/v1/imports/${upload.body.data?.batchId}/previews`)
        .set('Authorization', auth(state.director))
        .send({ sheet, target, mapping });
      const confirm = await http()
        .post(`/api/v1/imports/previews/${preview.body.data?.importId}/confirm`)
        .set('Authorization', auth(state.director));
      return { upload: upload.status, preview: preview.status, summary: preview.body.data?.summary, confirm: confirm.status, result: confirm.body.data, error: confirm.body.error ?? preview.body.error ?? upload.body.error };
    };
    const centers = await importSheet(await workbook('2026', [['', 'Codigo', 'Nombre'], [null, ...REAL_CENTER]]), 'centros de costo.xlsx', '2026', 'COST_CENTERS', { code: 'B', name: 'C' });
    const assets = await importSheet(await workbook('ACTIVOS', [ASSET_HEADER, REAL_ASSET_ROW]), 'informe activos.xlsx', 'ACTIVOS', 'ASSETS', {
      legacyAssetId: 'A',
      legacyCode: 'B',
      description: 'C',
      costCenterCode: 'H',
      acquisitionDate: 'I',
      usefulLifeYears: 'L',
      acquisitionPrice: 'U',
    });
    const [asset] = (await dataSource.query(
      `SELECT a.id, a.current_cost_center_id FROM asset a JOIN asset_import_origin o ON o.asset_id = a.id WHERE o.legacy_asset_id = '15796'`,
    )) as Array<{ id: string; current_cost_center_id: string }>;
    state.assetId = asset?.id;
    state.costCenterId = asset?.current_cost_center_id;
    const search = await http().get('/api/v1/assets').query({ q: '01979' }).set('Authorization', auth(state.director));
    record('importación', Boolean(asset), { centers, assets, searchByLegacyCode: search.body.data?.total, identifiers: search.body.data?.items?.[0]?.identifiers });
    expect(asset).toBeDefined();
    expect(search.body.data?.total).toBe(1);
  });

  it('3. genera el acta para ese activo y la convierte a PDF con Gotenberg', async () => {
    const generated = await http()
      .post('/api/v1/documents')
      .set('Authorization', auth(state.director))
      .send({
        formatKey: 'OCI-01-55',
        costCenterId: state.costCenterId,
        responsiblePersonId: state.responsible?.personId,
        assetIds: [state.assetId],
        signers: { AUDITA: state.auditor?.personId },
      });
    state.documentId = generated.body.data?.id;
    const pdf = await http().get(`/api/v1/documents/${state.documentId}/pdf`).set('Authorization', auth(state.director)).buffer(true).parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    });
    const docx = await http().get(`/api/v1/documents/${state.documentId}/docx`).set('Authorization', auth(state.director)).buffer(true).parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    });
    const body = pdf.body as Buffer;
    let pages: number | null = null;
    let text = '';
    if (pdf.status === 200) {
      await writeFile(join(OUTPUT, '1-acta-generada.pdf'), body);
      await writeFile(join(OUTPUT, '1-acta-generada.docx'), docx.body as Buffer);
      pages = (await PDFDocument.load(body)).getPageCount();
      text = squash(await pdfText(body));
      await writeFile(join(OUTPUT, '1-acta-generada.txt'), text);
    }
    const content = {
      totalLine: text.match(/Total, elementos entregados: \S+/)?.[0] ?? null,
      assetRow: text.match(/1 15796 01979 Sillas Interlocutoras\/verdes 1 \S+( \S+)?/)?.[0] ?? null,
      pdfLeftovers: sampleLeftovers(text, OCI_01_55_SAMPLE, { numbers: true }),
      docxLeftovers: docx.status === 200 ? findLeftovers(docx.body as Buffer, OCI_01_55_SAMPLE) : ['sin DOCX'],
    };
    const detail = await http().get(`/api/v1/documents/${state.documentId}`).set('Authorization', auth(state.director));
    const envelope = detail.body.data?.verification as { code: string; url: string } | null | undefined;
    state.verificationCode = envelope?.code;
    record('generación y PDF', generated.status === 201 && pdf.status === 200, {
      generate: generated.status,
      number: generated.body.data?.number,
      status: generated.body.data?.status,
      error: generated.body.error,
      pdfStatus: pdf.status,
      pdfBytes: body?.length,
      pages,
      verification: envelope,
      content,
    });
    expect(generated.status).toBe(201);
    expect(body.subarray(0, 5).toString()).toBe('%PDF-');
    expect(envelope?.code).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(envelope?.url.endsWith(`/${envelope?.code}`)).toBe(true);
    expect(content.assetRow).toBe('1 15796 01979 Sillas Interlocutoras/verdes 1 Sin verificar');
    expect(content.totalLine).toBe('Total, elementos entregados: 1');
    expect(content.pdfLeftovers).toEqual([]);
    expect(content.docxLeftovers).toEqual([]);
  });

  it('4. firman en el orden configurado, cada uno con su rúbrica', async () => {
    const rubric = async (text: string) => `data:image/png;base64,${(await QRCode.toBuffer(text, { width: 160 })).toString('base64')}`;
    const detailFor = async (who: User | undefined) =>
      (await http().get(`/api/v1/documents/${state.documentId}`).set('Authorization', auth(who))).body.data;
    const before = await detailFor(state.responsible);
    const early = await http()
      .post(`/api/v1/documents/${state.documentId}/signatures/2`)
      .set('Authorization', auth(state.auditor))
      .send({ rubric: await rubric('rubrica control interno') });
    const first = await http()
      .post(`/api/v1/documents/${state.documentId}/signatures/1`)
      .set('Authorization', auth(state.responsible))
      .set('X-Forwarded-For', '181.49.10.20')
      .send({ rubric: await rubric('rubrica responsable') });
    const second = await http()
      .post(`/api/v1/documents/${state.documentId}/signatures/2`)
      .set('Authorization', auth(state.auditor))
      .set('X-Forwarded-For', '181.49.10.21')
      .send({ rubric: await rubric('rubrica control interno') });
    const signedPdf = await http().get(`/api/v1/documents/${state.documentId}/pdf`).set('Authorization', auth(state.director)).buffer(true).parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    });
    let signedText = '';
    if (signedPdf.status === 200) {
      await writeFile(join(OUTPUT, '2-acta-firmada.pdf'), signedPdf.body as Buffer);
      signedText = squash(await pdfText(signedPdf.body as Buffer));
      await writeFile(join(OUTPUT, '2-acta-firmada.txt'), signedText);
    }
    const signedLeftovers = sampleLeftovers(signedText, OCI_01_55_SAMPLE, { numbers: false });
    const evidence = (await dataSource.query(
      `SELECT s.sign_order, s.name, host(s.ip_address) AS ip, s.session_id IS NOT NULL AS session, s.mfa_enabled, s.pdf_sha256_before, s.pdf_sha256_after
       FROM signature_envelope_signer s JOIN signature_envelope e ON e.id = s.envelope_id WHERE e.document_id = $1 ORDER BY s.sign_order`,
      [state.documentId],
    )) as Array<Record<string, unknown>>;
    record('firmas', first.status === 200 && second.status === 200, {
      turnBefore: before?.currentTurn,
      viewerBefore: before?.viewer,
      earlyAttempt: [early.status, early.body.error?.code],
      first: [first.status, first.body.error?.code ?? first.body.data?.status],
      second: [second.status, second.body.error?.code ?? second.body.data?.status],
      signedFile: signedPdf.header['content-disposition'],
      signedPages: signedPdf.status === 200 ? (await PDFDocument.load(signedPdf.body as Buffer)).getPageCount() : null,
      evidence,
      signedLeftovers,
    });
    expect(signedLeftovers).toEqual([]);
    expect(early.body.error?.code).toBe('SIGNATURE_OUT_OF_ORDER');
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.data?.status).toBe('SIGNED');
  });

  it('5. la página pública atestigua la firma sin sesión', async () => {
    const response = await http().get(`/api/v1/public/signatures/${state.verificationCode}`);
    record('verificación pública', response.status === 200, { status: response.status, attestation: response.body.data });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ status: 'COMPLETED', integrity: 'INTACT' });
    expect(response.body.data.signers.map((item: { name: string }) => item.name)).toEqual(['Laura Responsable E2E', 'Carolina Directora E2E']);
  });

  it('6. alterar el PDF almacenado hace que la verificación reporte ALTERED', async () => {
    const [envelope] = (await dataSource.query('SELECT current_pdf_key, current_pdf_sha256 FROM signature_envelope WHERE document_id = $1', [state.documentId])) as Array<{ current_pdf_key: string; current_pdf_sha256: string }>;
    const path = join(STORAGE, envelope?.current_pdf_key ?? '');
    const stored = await readFile(path);
    const intactHash = sha256(stored);
    await writeFile(path, Buffer.concat([stored, Buffer.from('\n% alterado por la prueba E2E')]));
    const response = await http().get(`/api/v1/public/signatures/${state.verificationCode}`);
    record('alteración detectada', response.body.data?.integrity === 'ALTERED', {
      storedMatchedBeforeAltering: intactHash === envelope?.current_pdf_sha256,
      integrity: response.body.data?.integrity,
    });
    expect(response.body.data?.integrity).toBe('ALTERED');
  });
});
