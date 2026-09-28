// Formatos SGC administrables (document_format / document_format_version): crear formato y versión por API, versionar
// sin sobrescribir (las actas conservan la versión con que se emitieron: hoja de firmas y verificación pública con las
// etiquetas viejas), numeración configurable y rechazo de una versión que rompería un proceso enchufado en código.
// Formatos, códigos SGC y firmantes de este archivo son de PRUEBA; afterAll los borra.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { createAppValidationPipe } from '../../src/common/pipes/app-validation.pipe.js';
import { TokenService } from '../../src/modules/auth/services/token.service.js';
import { PDF_CONVERTER } from '../../src/modules/documents/pdf/pdf-converter.js';
import { bogotaToday } from '../../src/modules/documents/services/document-format-catalog.service.js';
import { scalar, useSharedStorage } from './helpers.js';
import { DocxTextPdfConverter, pdfText, squash } from './pdf-text.js';

const TEMPLATE = 'templates/formats/OCI-01-55-v2.docx';

interface User {
  readonly userId: string;
  readonly personId: string;
  readonly token: string;
}

const addDays = (date: string, days: number): string => {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

describe('Formatos SGC administrables y versionados (PostgreSQL real)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let rubric = '';
  const tag = randomUUID().slice(0, 6).toUpperCase();
  const FREE = `IT-FMT-${tag}`;
  const YEARLY = `IT-ANUAL-${tag}`;
  const users: Record<string, User> = {};

  const http = () => request(app.getHttpServer());
  const auth = (who: string) => ({ Authorization: `Bearer ${users[who]?.token ?? ''}` });

  const user = async (name: string, role: string | null, mfa: boolean) => {
    const suffix = randomUUID().slice(0, 8);
    const personId = await scalar<string>(
      dataSource,
      `INSERT INTO person (first_name, last_name, email, document_type, document_number, position_title)
       VALUES ($1, 'Formatos', $2, 'CC', $3, 'Cargo de prueba') RETURNING id`,
      [name, `formatos.${suffix}@unac.edu.co`, `7${Date.now().toString().slice(-7)}${Math.floor(Math.random() * 100)}`],
    );
    const userId = await scalar<string>(
      dataSource,
      `INSERT INTO app_user (person_id, username, password_hash, mfa_enabled, status) VALUES ($1, $2, 'x', $3, 'ACTIVE') RETURNING id`,
      [personId, `formatos.${suffix}`, mfa],
    );
    const sessionId = randomUUID();
    await dataSource.query(
      `INSERT INTO refresh_token_family (id, user_id, current_jti, expires_at, mfa_verified_at)
       VALUES ($1, $2, $3, NOW() + interval '1 day', CASE WHEN $4::boolean THEN NOW() END)`,
      [sessionId, userId, randomUUID(), mfa],
    );
    if (role) {
      await dataSource.query(`INSERT INTO user_role (user_id, role_id, scope_type) SELECT $1, id, 'GLOBAL' FROM role WHERE code = $2`, [
        userId,
        role,
      ]);
    }
    const token = app.get(TokenService).signAccessToken({
      id: userId,
      personId,
      username: `formatos.${suffix}`,
      roles: [],
      scopes: [],
      mustChangePassword: false,
      sessionId,
    });
    users[name] = { userId, personId, token };
  };

  const baseVersion = {
    sgcCode: 'PRUEBA-FMT',
    sgcVersion: '1',
    name: 'Acta administrable de prueba',
    signers: [
      { order: 1, role: 'RECIBE', label: 'Recibe', source: 'RESPONSIBLE' },
      { order: 2, role: 'AUDITA', label: 'Control Interno', source: 'REQUEST' },
    ],
    numbering: { width: 3, perYear: false, lastIssued: 41 },
  };

  const uploadTemplate = (key: string) =>
    http()
      .post(`/api/v1/documents/formats/${key}/templates`)
      .set(auth('director'))
      .field('effectiveDate', bogotaToday())
      .attach('file', TEMPLATE, 'plantilla-prueba.docx');

  const generate = (key: string, signers: Record<string, string | undefined>) =>
    http()
      .post('/api/v1/documents')
      .set(auth('director'))
      .send({ formatKey: key, responsiblePersonId: users['responsable']?.personId, signers });

  const versionOf = (documentId: string) =>
    scalar<number>(
      dataSource,
      'SELECT v.version_number FROM document d JOIN document_format_version v ON v.id = d.format_version_id WHERE d.id = $1',
      [documentId],
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PDF_CONVERTER)
      .useValue(new DocxTextPdfConverter())
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
    for (const job of app.get(SchedulerRegistry).getCronJobs().values()) {
      await job.stop();
    }
    dataSource = app.get(DataSource);
    await useSharedStorage(dataSource);
    rubric = `data:image/png;base64,${(await QRCode.toBuffer('rubrica', { width: 120 })).toString('base64')}`;
    await user('director', 'INTERNAL_CONTROL_DIRECTOR', true);
    await user('auditor', 'AUDITOR', false);
    await user('responsable', null, false);
    await user('contador', null, false);
  });

  afterAll(async () => {
    const keys = [FREE, YEARLY];
    const ids = (
      (await dataSource.query('SELECT id FROM document WHERE format_key = ANY($1)', [keys])) as Array<{ id: string }>
    ).map((row) => row.id);
    await dataSource.query(
      'DELETE FROM signature_envelope_signer WHERE envelope_id IN (SELECT id FROM signature_envelope WHERE document_id = ANY($1))',
      [ids],
    );
    await dataSource.query('DELETE FROM signature_signing_link WHERE document_id = ANY($1)', [ids]);
    await dataSource.query('DELETE FROM signature_envelope WHERE document_id = ANY($1)', [ids]);
    await dataSource.query('DELETE FROM document WHERE id = ANY($1)', [ids]);
    await dataSource.query('DELETE FROM document_request WHERE format_key = ANY($1)', [keys]);
    await dataSource.query('DELETE FROM document_template_version WHERE format_key = ANY($1)', [keys]);
    await dataSource.query('DELETE FROM document_sequence WHERE format_key = ANY($1)', [keys]);
    await dataSource.query('DELETE FROM document_format_version WHERE format_key = ANY($1)', [keys]);
    await dataSource.query('DELETE FROM document_format WHERE key = ANY($1)', [keys]);
    await app.close();
  });

  it('crear un formato: permisos, validación, plantilla por API y generación con POST /documents', async () => {
    const body = { ...baseVersion, key: FREE, readPermission: 'asset:read:global', generatePermission: 'asset:update:global' };
    // Leer es document_template:read:global; administrar, document_template:update:global.
    expect((await http().post('/api/v1/documents/formats').set(auth('auditor')).send(body)).status).toBe(403);
    expect((await http().get(`/api/v1/documents/formats/OCI-01-55/versions`).set(auth('auditor'))).status).toBe(200);
    expect((await http().get('/api/v1/documents/formats').set(auth('responsable'))).status).toBe(403);

    const created = await http().post('/api/v1/documents/formats').set(auth('director')).send(body).expect(201);
    expect(created.body.data).toMatchObject({
      key: FREE,
      sgcCode: 'PRUEBA-FMT',
      version: '1',
      versionNumber: 1,
      effectiveFrom: bogotaToday(),
      ready: true,
      activeTemplate: null,
      lastIssuedNumber: null,
      scheduledVersion: null,
      process: null,
      numbering: { width: 3, perYear: false, lastIssued: 41 },
    });

    const duplicate = await http().post('/api/v1/documents/formats').set(auth('director')).send(body);
    expect([duplicate.status, duplicate.body.error.code]).toEqual([409, 'DOCUMENT_FORMAT_ALREADY_EXISTS']);
    const badPermission = await http()
      .post('/api/v1/documents/formats')
      .set(auth('director'))
      .send({ ...body, key: `${FREE}-X`, generatePermission: 'no:existe:global' });
    expect([badPermission.status, badPermission.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);
    const repeatedRole = await http()
      .post('/api/v1/documents/formats')
      .set(auth('director'))
      .send({ ...body, key: `${FREE}-Y`, signers: [baseVersion.signers[0], { ...baseVersion.signers[1], role: 'RECIBE' }] });
    expect([repeatedRole.status, repeatedRole.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);
    expect(await scalar<number>(dataSource, 'SELECT count(*)::int FROM document_format WHERE key LIKE $1', [`${FREE}-%`])).toBe(0);

    // Sin plantilla todavía: el motor lo dice explícitamente.
    expect((await generate(FREE, { AUDITA: users['director']?.personId })).body.error.code).toBe('TEMPLATE_NOT_ACTIVE');
    const uploaded = await uploadTemplate(FREE).expect(201);
    expect(
      await scalar<string>(dataSource, "SELECT sgc_code || '/' || sgc_version FROM document_template_version WHERE id = $1", [
        uploaded.body.data.id,
      ]),
    ).toBe('PRUEBA-FMT/1');

    const document = await generate(FREE, { AUDITA: users['director']?.personId }).expect(201);
    expect(document.body.data.number).toBe('042');
    expect(await versionOf(document.body.data.id)).toBe(1);
  });

  it('editar firmantes crea una versión nueva; el acta previa conserva la suya en detalle, hoja de firmas y verificación', async () => {
    const [first] = (await dataSource.query('SELECT id FROM document WHERE format_key = $1', [FREE])) as Array<{ id: string }>;
    const firstId = first?.id ?? '';
    await http().post(`/api/v1/documents/${firstId}/signatures/1`).set(auth('responsable')).send({ rubric }).expect(200);
    await http().post(`/api/v1/documents/${firstId}/signatures/2`).set(auth('director')).send({ rubric }).expect(200);

    const v2 = await http()
      .post(`/api/v1/documents/formats/${FREE}/versions`)
      .set(auth('director'))
      .send({
        ...baseVersion,
        sgcCode: 'PRUEBA-FMT2',
        sgcVersion: '2',
        signers: [
          { order: 1, role: 'RECIBE', label: 'Quien recibe (v2)', source: 'RESPONSIBLE' },
          { order: 2, role: 'CONTABILIDAD', label: 'Contabilidad (v2)', source: 'REQUEST' },
          { order: 3, role: 'AUDITA', label: 'Auditoría (v2)', source: 'REQUEST' },
        ],
        changeReason: 'Contabilidad firma desde esta versión',
      })
      .expect(201);
    expect(v2.body.data).toMatchObject({ versionNumber: 2, status: 'CURRENT', sgcCode: 'PRUEBA-FMT2', documentCount: 0 });
    expect(v2.body.data.createdBy).toMatchObject({ userId: users['director']?.userId, name: 'director Formatos' });

    const history = (await http().get(`/api/v1/documents/formats/${FREE}/versions`).set(auth('director')).expect(200)).body.data;
    expect(history.map((item: { versionNumber: number; status: string; documentCount: number }) => [item.versionNumber, item.status, item.documentCount])).toEqual([
      [2, 'CURRENT', 0],
      [1, 'SUPERSEDED', 1],
    ]);
    // La versión 1 no se reescribió (y la BD no deja).
    expect(history[1].signers.map((signer: { label: string }) => signer.label)).toEqual(['Recibe', 'Control Interno']);
    await expect(
      dataSource.query('UPDATE document_format_version SET name = $2 WHERE id = $1', [history[1].versionId, 'otro']),
    ).rejects.toThrow(/no se modifica/);

    // El acta firmada con la versión 1 sigue describiendo sus reglas.
    const firstDetail = (await http().get(`/api/v1/documents/${firstId}`).set(auth('director')).expect(200)).body.data;
    expect(firstDetail.status).toBe('SIGNED');
    expect(firstDetail.signatures.map((signature: { roleLabel: string }) => signature.roleLabel)).toEqual(['Recibe', 'Control Interno']);
    const firstAttestation = (await http().get(`/api/v1/public/signatures/${firstDetail.verification.code}`).expect(200)).body.data;
    expect(firstAttestation.signers.map((signer: { role: string }) => signer.role)).toEqual(['Recibe', 'Control Interno']);
    const firstPdf = await http().get(`/api/v1/documents/${firstId}/pdf`).set(auth('director')).expect(200);
    const firstSheet = squash(await pdfText(firstPdf.body as Buffer));
    expect(firstSheet).toContain('PRUEBA-FMT · Acta administrable de prueba');
    expect(firstSheet).toContain('Control Interno');
    expect(firstSheet).not.toContain('(v2)');

    // Una acta nueva usa la versión 2: su nuevo firmante es obligatorio y sus etiquetas son las nuevas.
    const missing = await generate(FREE, { AUDITA: users['director']?.personId });
    expect([missing.status, missing.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);
    expect(missing.body.error.message).toContain('Contabilidad (v2)');
    const second = await generate(FREE, { AUDITA: users['director']?.personId, CONTABILIDAD: users['contador']?.personId }).expect(201);
    expect(second.body.data.number).toBe('043');
    expect(await versionOf(second.body.data.id)).toBe(2);
    const secondDetail = (await http().get(`/api/v1/documents/${second.body.data.id}`).set(auth('director')).expect(200)).body.data;
    expect(secondDetail.signatures.map((signature: { roleLabel: string }) => signature.roleLabel)).toEqual([
      'Quien recibe (v2)',
      'Contabilidad (v2)',
      'Auditoría (v2)',
    ]);
    const secondAttestation = (await http().get(`/api/v1/public/signatures/${secondDetail.verification.code}`).expect(200)).body.data;
    expect(secondAttestation.signers.map((signer: { role: string }) => signer.role)).toEqual([
      'Quien recibe (v2)',
      'Contabilidad (v2)',
      'Auditoría (v2)',
    ]);
    // Hoja de firmas del sobre (el PDF descargable sin firmar no la lleva): etiquetas de la versión 2.
    const envelopeLabels = (await dataSource.query(
      `SELECT s.role_label FROM signature_envelope_signer s JOIN signature_envelope e ON e.id = s.envelope_id
       WHERE e.document_id = $1 ORDER BY s.sign_order`,
      [second.body.data.id],
    )) as Array<{ role_label: string }>;
    expect(envelopeLabels.map((row) => row.role_label)).toEqual(['Quien recibe (v2)', 'Contabilidad (v2)', 'Auditoría (v2)']);

    // El listado muestra el código de la versión de cada acta.
    const list = (await http().get('/api/v1/documents').query({ formatKey: FREE }).set(auth('director')).expect(200)).body.data.items as Array<{
      documentId: string;
      sgcCode: string;
    }>;
    expect(list.find((item) => item.documentId === firstId)?.sgcCode).toBe('PRUEBA-FMT');
    expect(list.find((item) => item.documentId === second.body.data.id)?.sgcCode).toBe('PRUEBA-FMT2');
    // Y la vigente en GET /documents/formats es la 2.
    const formats = (await http().get('/api/v1/documents/formats').set(auth('director')).expect(200)).body.data;
    expect(formats.find((format: { key: string }) => format.key === FREE)).toMatchObject({
      versionNumber: 2,
      sgcCode: 'PRUEBA-FMT2',
      lastIssuedNumber: 43,
    });
  });

  it('numeración configurable: ancho y anual por versión; el valor inicial solo antes del primer consecutivo; vigencia futura', async () => {
    const v2Signers = [
      { order: 1, role: 'RECIBE', label: 'Quien recibe (v2)', source: 'RESPONSIBLE' },
      { order: 2, role: 'AUDITA', label: 'Auditoría (v2)', source: 'REQUEST' },
    ];
    const started = await http()
      .post(`/api/v1/documents/formats/${FREE}/versions`)
      .set(auth('director'))
      .send({ ...baseVersion, signers: v2Signers, numbering: { width: 3, perYear: false, lastIssued: 100 } });
    expect([started.status, started.body.error.code]).toEqual([409, 'DOCUMENT_FORMAT_SEQUENCE_STARTED']);

    await http()
      .post(`/api/v1/documents/formats/${FREE}/versions`)
      .set(auth('director'))
      .send({ ...baseVersion, signers: v2Signers, numbering: { width: 5, perYear: false, lastIssued: 41 } })
      .expect(201);
    const wide = await generate(FREE, { AUDITA: users['director']?.personId }).expect(201);
    expect(wide.body.data.number).toBe('00044');
    expect(await versionOf(wide.body.data.id)).toBe(3);

    // Vigencia: nunca en el pasado; una versión futura queda programada y no se usa todavía.
    const past = await http()
      .post(`/api/v1/documents/formats/${FREE}/versions`)
      .set(auth('director'))
      .send({ ...baseVersion, signers: v2Signers, effectiveFrom: addDays(bogotaToday(), -1) });
    expect([past.status, past.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);
    const tomorrow = addDays(bogotaToday(), 1);
    const scheduled = await http()
      .post(`/api/v1/documents/formats/${FREE}/versions`)
      .set(auth('director'))
      .send({ ...baseVersion, name: 'Nombre que rige mañana', signers: v2Signers, numbering: { width: 5, perYear: false, lastIssued: 41 }, effectiveFrom: tomorrow })
      .expect(201);
    expect(scheduled.body.data).toMatchObject({ versionNumber: 4, status: 'SCHEDULED', effectiveFrom: tomorrow });
    const formats = (await http().get('/api/v1/documents/formats').set(auth('director')).expect(200)).body.data;
    expect(formats.find((format: { key: string }) => format.key === FREE)).toMatchObject({
      versionNumber: 3,
      name: 'Acta administrable de prueba',
      scheduledVersion: { versionNumber: 4, effectiveFrom: tomorrow },
    });
    const stillV3 = await generate(FREE, { AUDITA: users['director']?.personId }).expect(201);
    expect(await versionOf(stillV3.body.data.id)).toBe(3);
    const beforeScheduled = await http()
      .post(`/api/v1/documents/formats/${FREE}/versions`)
      .set(auth('director'))
      .send({ ...baseVersion, signers: v2Signers, numbering: { width: 5, perYear: false, lastIssued: 41 } });
    expect([beforeScheduled.status, beforeScheduled.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);

    // Consecutivo anual con valor inicial del año en curso.
    const year = String(new Date().getFullYear());
    const noYear = await http()
      .post('/api/v1/documents/formats')
      .set(auth('director'))
      .send({
        ...baseVersion,
        key: YEARLY,
        readPermission: 'asset:read:global',
        generatePermission: 'asset:update:global',
        numbering: { width: 2, perYear: true, lastIssued: 7 },
      });
    expect([noYear.status, noYear.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);
    await http()
      .post('/api/v1/documents/formats')
      .set(auth('director'))
      .send({
        ...baseVersion,
        key: YEARLY,
        readPermission: 'asset:read:global',
        generatePermission: 'asset:update:global',
        numbering: { width: 2, perYear: true, lastIssued: 7, lastIssuedPeriod: year },
      })
      .expect(201);
    await uploadTemplate(YEARLY).expect(201);
    expect((await generate(YEARLY, { AUDITA: users['director']?.personId }).expect(201)).body.data.number).toBe(`${year}-08`);
    expect((await generate(YEARLY, { AUDITA: users['director']?.personId }).expect(201)).body.data.number).toBe(`${year}-09`);
  });

  it('una versión que quita, añade o cambia el origen de un rol que usa un proceso se rechaza con error explícito', async () => {
    const formats = (await http().get('/api/v1/documents/formats').set(auth('director')).expect(200)).body.data as Array<{
      key: string;
      process: { name: string; requiredSigners: Array<{ role: string; source: string }> | null } | null;
    }>;
    const byKey = new Map(formats.map((format) => [format.key, format]));
    expect(byKey.get('OCI-01-65')?.process).toEqual({
      name: 'Préstamos (acta de entrega)',
      requiredSigners: [
        { role: 'ENTREGA', source: 'REQUEST' },
        { role: 'RECIBE', source: 'RESPONSIBLE' },
        { role: 'AUDITA', source: 'REQUEST' },
      ],
    });
    expect(byKey.get('OCI-01-55')?.process?.name).toBe('Entregas de activos');
    expect(byKey.get('LOAN_RETURN')?.process).toEqual({ name: 'Préstamos (acta de devolución)', requiredSigners: null });
    expect(byKey.get('OCI-17-89')?.process).toEqual({
      name: 'Traslados de activos',
      requiredSigners: [
        { role: 'ENTREGA', source: 'REQUEST' },
        { role: 'RECIBE', source: 'RESPONSIBLE' },
        { role: 'CONTROL_INTERNO', source: 'REQUEST' },
        { role: 'CONTABILIDAD', source: 'REQUEST' },
      ],
    });
    // Orden: por código SGC, el formato sin código al final (como el catálogo en código).
    const seeded = formats.map((format) => format.key).filter((key) => !key.startsWith('IT-'));
    expect(seeded.slice(0, 6)).toEqual(['OCI-01-55', 'OCI-01-65', 'OCI-17-89', 'OCI-17-90-BAJA', 'OCI-17-90-INFORME', 'OCI-21-37']);
    expect(seeded.at(-1)).toBe('LOAN_RETURN');

    const loanVersion = (signers: ReadonlyArray<{ order: number; role: string; label: string; source: string }>) =>
      http()
        .post('/api/v1/documents/formats/OCI-01-65/versions')
        .set(auth('director'))
        .send({
          sgcCode: 'OCI-01-65',
          sgcVersion: '3',
          name: 'Acta de préstamo temporal de activos fijos',
          signers,
          numbering: { width: 4, perYear: true, lastIssued: 1, lastIssuedPeriod: '2026' },
        });
    const withoutAudit = await loanVersion([
      { order: 1, role: 'ENTREGA', label: 'Entrega', source: 'REQUEST' },
      { order: 2, role: 'RECIBE', label: 'Recibe', source: 'RESPONSIBLE' },
    ]);
    expect([withoutAudit.status, withoutAudit.body.error.code]).toEqual([409, 'DOCUMENT_FORMAT_BREAKS_PROCESS']);
    expect(withoutAudit.body.error.message).toContain('Falta el rol AUDITA');
    const changedSource = await loanVersion([
      { order: 1, role: 'ENTREGA', label: 'Entrega', source: 'RESPONSIBLE' },
      { order: 2, role: 'RECIBE', label: 'Recibe', source: 'RESPONSIBLE' },
      { order: 3, role: 'AUDITA', label: 'Control Interno', source: 'REQUEST' },
    ]);
    expect([changedSource.status, changedSource.body.error.code]).toEqual([409, 'DOCUMENT_FORMAT_BREAKS_PROCESS']);
    expect(changedSource.body.error.message).toContain('ENTREGA debe tener origen REQUEST');
    const extraRole = await loanVersion([
      { order: 1, role: 'ENTREGA', label: 'Entrega', source: 'REQUEST' },
      { order: 2, role: 'RECIBE', label: 'Recibe', source: 'RESPONSIBLE' },
      { order: 3, role: 'AUDITA', label: 'Control Interno', source: 'REQUEST' },
      { order: 4, role: 'TESTIGO', label: 'Testigo', source: 'REQUEST' },
    ]);
    expect([extraRole.status, extraRole.body.error.code]).toEqual([409, 'DOCUMENT_FORMAT_BREAKS_PROCESS']);
    const handoverWithoutReceiver = await http()
      .post('/api/v1/documents/formats/OCI-01-55/versions')
      .set(auth('director'))
      .send({
        sgcCode: 'OCI-01-55',
        sgcVersion: '3',
        name: 'Acta de entrega y asignación de activos fijos',
        signers: [{ order: 1, role: 'AUDITA', label: 'Control Interno', source: 'REQUEST' }],
        numbering: { width: 4, perYear: false, lastIssued: 92 },
      });
    expect([handoverWithoutReceiver.status, handoverWithoutReceiver.body.error.code]).toEqual([409, 'DOCUMENT_FORMAT_BREAKS_PROCESS']);
    expect(
      await scalar<number>(dataSource, "SELECT count(*)::int FROM document_format_version WHERE format_key IN ('OCI-01-65', 'OCI-01-55')"),
    ).toBe(2);
    expect((await http().get('/api/v1/documents/formats/NO-EXISTE/versions').set(auth('director'))).status).toBe(404);
    expect((await http().post('/api/v1/documents/formats/NO-EXISTE/versions').set(auth('director')).send(baseVersion)).status).toBe(404);
  });
});
