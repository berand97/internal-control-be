// Acta de devolución (LOAN_RETURN) generada de punta a punta con un formato de PRUEBA.
// El formato institucional no existe (sin código SGC ni firmantes): aquí, y solo aquí, el catálogo del motor se
// sustituye (DOCUMENT_FORMAT_CATALOG) por uno donde LOAN_RETURN tiene un código y firmantes de prueba, y la plantilla
// es un DOCX mínimo armado en el test con el contrato de marcadores documentado en document-formats.ts.
// Nada de esto es institucional: código, firmantes y plantilla son fixtures.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SchedulerRegistry } from '@nestjs/schedule';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import PizZip from 'pizzip';
import QRCode from 'qrcode';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { createAppValidationPipe } from '../../src/common/pipes/app-validation.pipe.js';
import { TokenService } from '../../src/modules/auth/services/token.service.js';
import {
  DOCUMENT_FORMAT_CATALOG,
  DOCUMENT_FORMATS,
  type DocumentFormat,
} from '../../src/modules/documents/domain/document-formats.js';
import { PDF_CONVERTER } from '../../src/modules/documents/pdf/pdf-converter.js';
import { DocumentEngineService } from '../../src/modules/documents/services/document-engine.service.js';
import { bogotaDate, longSpanishDate } from '../../src/modules/loans/domain/loan-dates.js';
import { StorageService } from '../../src/shared/storage/storage.service.js';
import { scalar, useSharedStorage } from './helpers.js';
import { DocxTextPdfConverter } from './pdf-text.js';

const FORMAT = 'LOAN_RETURN';

/** Formato de PRUEBA: código y firmantes inventados para el test, nunca para producción. */
const TEST_CATALOG: ReadonlyArray<DocumentFormat> = DOCUMENT_FORMATS.map((format) =>
  format.key === FORMAT
    ? {
        ...format,
        sgcCode: 'PRUEBA-DEV',
        version: '0',
        signers: [
          { order: 1, role: 'DEVUELVE', label: 'Devuelve (prueba)', source: 'RESPONSIBLE' },
          { order: 2, role: 'RECIBE_ORIGEN', label: 'Recibe en origen (prueba)', source: 'REQUEST' },
        ],
      }
    : format,
);

/** DOCX mínimo con el contrato de marcadores del acta de devolución (document-formats.ts). */
const fixtureTemplate = (): Buffer => {
  const zip = new PizZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  const paragraph = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const lines = [
    'CODIGO|{{formato.codigo}}|NUMERO|{{documento.numero}}|',
    'ORIGEN|{{centroCosto.codigo}} {{centroCosto.nombre}}|',
    'DESTINO|{{campos.centroDestinoCodigo}} {{campos.centroDestinoNombre}}|',
    'FECHAS|{{campos.fechaEntrega}}|{{campos.fechaEstimadaDevolucion}}|{{campos.fechaDevolucion}}|{{campos.fechaRecepcion}}|',
    'USO|{{campos.tiempoUsoReal}}|',
    'ACTA|{{campos.actaEntregaCodigo}}|{{campos.actaEntregaNumero}}|',
    'TOTALES|{{campos.totalDevueltos}}|{{campos.totalPerdidos}}|{{campos.totalPendientes}}|{{totalElementos}}|',
    'OBS|{{campos.observaciones}}|',
    '{{#activos}}ACTIVO|{{indice}}|{{codigo}}|{{descripcion}}|{{campos.condicionDevolucion}}|{{campos.fechaDevolucion}}|{{campos.estadoEntrega}}|{{/activos}}',
    'DEVUELVE|{{firmante.devuelve.nombre}}|{{firmante.devuelve.cargo}}|',
    'RECIBE_ORIGEN|{{firmante.recibe_origen.nombre}}|{{firmante.recibe_origen.cargo}}|',
  ];
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${lines.map(paragraph).join('')}</w:body></w:document>`,
  );
  return Buffer.from(zip.generate({ type: 'nodebuffer' }));
};

const docxText = (docx: Buffer): string =>
  new PizZip(docx).file('word/document.xml')?.asText().replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '') ?? '';

interface User {
  userId: string;
  personId: string;
  token: string;
  fullName: string;
}

describe('Acta de devolución LOAN_RETURN con formato de prueba: se encola en la recepción y enlaza los movimientos RETURN (PostgreSQL real)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let engine: DocumentEngineService;
  let openapi: OpenAPIObject;
  let rubric: string;
  let centerA = '';
  let centerB = '';
  let categoryId = '';
  let templateId = '';
  let loanId = '';
  const users: Record<string, User> = {};
  const tag = randomUUID().slice(0, 6).toUpperCase();

  const http = () => request(app.getHttpServer());
  const auth = (who: string) => ({ Authorization: `Bearer ${users[who]?.token ?? ''}` });
  const drain = () => engine.processPending(1000);

  const user = async (name: string, first: string, title: string, role: string | null) => {
    const suffix = randomUUID().slice(0, 8);
    const personId = await scalar<string>(
      dataSource,
      `INSERT INTO person (first_name, last_name, email, document_type, document_number, position_title)
       VALUES ($1, 'Devolucion', $2, 'CC', $3, $4) RETURNING id`,
      [first, `devolucion.${suffix}@unac.edu.co`, `8${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 1000)}`, title],
    );
    const userId = await scalar<string>(
      dataSource,
      `INSERT INTO app_user (person_id, username, password_hash, mfa_enabled, status) VALUES ($1, $2, 'x', TRUE, 'ACTIVE') RETURNING id`,
      [personId, `devolucion.${suffix}`],
    );
    const sessionId = randomUUID();
    await dataSource.query(
      `INSERT INTO refresh_token_family (id, user_id, current_jti, expires_at, mfa_verified_at) VALUES ($1, $2, $3, NOW() + interval '1 day', NOW())`,
      [sessionId, userId, randomUUID()],
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
      username: `devolucion.${suffix}`,
      roles: [],
      scopes: [],
      mustChangePassword: false,
      sessionId,
    });
    users[name] = { userId, personId, token, fullName: `${first} Devolucion` };
  };

  const asset = (code: string, description: string) =>
    scalar<string>(
      dataSource,
      `INSERT INTO asset (internal_code, description, category_id, acquisition_type_id, acquisition_date,
         current_cost_center_id, physical_condition, created_by)
       VALUES ($1, $2, $3, (SELECT id FROM acquisition_type WHERE code = 'PURCHASE'), '2022-05-01', $4, 'GOOD', $5)
       RETURNING id`,
      [code, description, categoryId, centerA, users['director']?.userId],
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PDF_CONVERTER)
      .useValue(new DocxTextPdfConverter())
      .overrideProvider(DOCUMENT_FORMAT_CATALOG)
      .useValue(TEST_CATALOG)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
    for (const job of app.get(SchedulerRegistry).getCronJobs().values()) {
      await job.stop();
    }
    dataSource = app.get(DataSource);
    engine = app.get(DocumentEngineService);
    openapi = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    await useSharedStorage(dataSource);
    rubric = `data:image/png;base64,${(await QRCode.toBuffer('rubrica', { width: 120 })).toString('base64')}`;
    centerA = await scalar<string>(dataSource, `INSERT INTO cost_center (external_code, name) VALUES ($1, 'ALMACEN ORIGEN PRUEBA') RETURNING id`, [
      `DA-${tag}`,
    ]);
    centerB = await scalar<string>(dataSource, `INSERT INTO cost_center (external_code, name) VALUES ($1, 'AULA DESTINO PRUEBA') RETURNING id`, [
      `DB-${tag}`,
    ]);
    categoryId = await scalar<string>(dataSource, `INSERT INTO asset_category (code, name) VALUES ($1, 'Devoluciones') RETURNING id`, [
      `DEV-${tag}`,
    ]);
    await user('director', 'Directora', 'Directora de Control Interno', 'INTERNAL_CONTROL_DIRECTOR');
    await user('solicitante', 'Solicitante', 'Coordinador', 'INTERNAL_CONTROL_DIRECTOR');
    await user('contacto', 'Contacto', 'DOCENTE QUE DEVUELVE', null);
    await user('receptor', 'Receptor', 'ALMACENISTA DE ORIGEN', null);
    templateId =
      (
        await engine.uploadTemplate(
          FORMAT,
          { buffer: fixtureTemplate(), originalname: 'acta-devolucion-prueba.docx' },
          { sgcVersion: '0', effectiveDate: bogotaDate(new Date()) },
          users['director']?.userId ?? null,
        )
      ).id ?? '';
  });

  afterAll(async () => {
    const ids = (
      (await dataSource.query(`SELECT id FROM document WHERE entity_type = 'LOAN' AND entity_id = $1`, [loanId || null])) as Array<{ id: string }>
    ).map((item) => item.id);
    await dataSource.query(
      'DELETE FROM signature_envelope_signer WHERE envelope_id IN (SELECT id FROM signature_envelope WHERE document_id = ANY($1))',
      [ids],
    );
    await dataSource.query('DELETE FROM signature_signing_link WHERE document_id = ANY($1)', [ids]);
    await dataSource.query('DELETE FROM signature_envelope WHERE document_id = ANY($1)', [ids]);
    await dataSource.query(`DELETE FROM document_request WHERE payload->>'entityId' = $1`, [loanId]);
    await dataSource.query('DELETE FROM document WHERE id = ANY($1)', [ids]);
    await dataSource.query('DELETE FROM document_template_version WHERE id = $1', [templateId || null]);
    await dataSource.query('DELETE FROM document_sequence WHERE format_key = $1', [FORMAT]);
    await app.close();
  });

  it('recepción: exige los firmantes REQUEST del catálogo, encola el acta, la genera con el contrato de marcadores y enlaza los RETURN', async () => {
    const damaged = await asset(`DV-${tag}-1`, 'PORTATIL DEVOLUCION');
    const good = await asset(`DV-${tag}-2`, 'MOUSE DEVOLUCION');
    const created = await http()
      .post('/api/v1/loans')
      .set(auth('solicitante'))
      .send({
        assets: [damaged, good],
        targetCostCenterId: centerB,
        expectedReturnDate: new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10),
        justification: 'Préstamo para probar el acta de devolución',
        contactPerson: users['contacto']?.personId,
      })
      .expect(201);
    loanId = created.body.data.id;
    await http().post(`/api/v1/loans/${loanId}/approve`).set(auth('director')).send({}).expect(200);
    await http()
      .post(`/api/v1/loans/${loanId}/deliver`)
      .set(auth('director'))
      .send({ deliveredByPersonId: users['receptor']?.personId, controlInternoPersonId: users['director']?.personId })
      .expect(200);
    // El acta de entrega no es lo que se prueba aquí: su solicitud se cancela y el préstamo se da por activo.
    await dataSource.query(
      `UPDATE document_request SET status = 'CANCELLED', cancelled_at = NOW(), cancel_reason = 'prueba de devolución'
       WHERE payload->>'entityId' = $1`,
      [loanId],
    );
    await dataSource.query(`UPDATE asset_loan SET status = 'ACTIVE' WHERE id = $1`, [loanId]);
    const deliveredAt = new Date((await http().get(`/api/v1/loans/${loanId}`).set(auth('director')).expect(200)).body.data.deliveredAt);
    const damagedAt = new Date(deliveredAt.getTime() + 1);
    await http()
      .post(`/api/v1/loans/${loanId}/return`)
      .set(auth('director'))
      .send({
        notes: 'Devuelto con la pantalla rayada',
        assetsReturned: [
          { assetId: damaged, condition: 'DAMAGED', returnedAt: damagedAt.toISOString() },
          { assetId: good, condition: 'GOOD' },
        ],
      })
      .expect(200);

    // Sin el firmante REQUEST del formato: 400 y nada cambia.
    const missing = await http().post(`/api/v1/loans/${loanId}/receive-return`).set(auth('director')).send({});
    expect([missing.status, missing.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);
    const unknownRole = await http()
      .post(`/api/v1/loans/${loanId}/receive-return`)
      .set(auth('director'))
      .send({ returnActSigners: { RECIBE_ORIGEN: users['receptor']?.personId, OTRO: users['director']?.personId } });
    expect(unknownRole.status).toBe(400);
    expect(await scalar<string>(dataSource, 'SELECT status::text FROM asset_loan WHERE id = $1', [loanId])).toBe('PENDING_RECEPTION');
    expect(await scalar<string>(dataSource, 'SELECT operational_status::text FROM asset WHERE id = $1', [damaged])).toBe('ON_LOAN');

    const received = await http()
      .post(`/api/v1/loans/${loanId}/receive-return`)
      .set(auth('director'))
      .send({ returnActSigners: { RECIBE_ORIGEN: users['receptor']?.personId } })
      .expect(200);
    expect(received.body.data.status).toBe('RETURNED');
    expect(received.body.data.returnActFormat).toMatchObject({ formatKey: FORMAT, sgcCode: 'PRUEBA-DEV', ready: true });
    expect(received.body.data.returnActs).toHaveLength(1);
    expect(received.body.data.returnActs[0]).toMatchObject({ status: 'PENDING', documentId: null });
    const requestId = received.body.data.returnActs[0].requestId as string;
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(openapi.paths['/api/v1/loans/{id}/receive-return']).toBeDefined();

    await drain();
    const loan = (await http().get(`/api/v1/loans/${loanId}`).set(auth('director')).expect(200)).body.data;
    const act = loan.returnActs[0];
    expect(act).toMatchObject({ status: 'GENERATED', requestId, error: null });
    expect(act.number).toMatch(/^\d{4}-0001$/);
    expect(loan.events.map((event: { eventType: string }) => event.eventType)).toContain('RETURN_ACT_GENERATED');
    // El acta de devolución no toca el acta de entrega del préstamo.
    expect(loan.deliveryDocumentId).toBeNull();

    // Acta ↔ movimiento RETURN de cada activo.
    const links = (await dataSource.query(
      `SELECT da.asset_id, m.movement_type, m.metadata->>'loanId' AS loan FROM document_asset da
       JOIN asset_movement m ON m.id = da.movement_id WHERE da.document_id = $1 ORDER BY da.asset_id`,
      [act.documentId],
    )) as Array<{ asset_id: string; movement_type: string; loan: string }>;
    expect(links.map((item) => item.asset_id).sort()).toEqual([damaged, good].sort());
    expect(links.every((item) => item.movement_type === 'RETURN' && item.loan === loanId)).toBe(true);

    const [row] = (await dataSource.query('SELECT docx_driver, docx_key FROM document WHERE id = $1', [act.documentId])) as Array<{
      docx_driver: 'project';
      docx_key: string;
    }>;
    const text = docxText(await app.get(StorageService).getFrom(row?.docx_driver ?? 'project', row?.docx_key ?? ''));
    expect(text).not.toContain('{{');
    expect(text).toContain(`CODIGO|PRUEBA-DEV|NUMERO|${act.number}|`);
    expect(text).toContain(`ORIGEN|DA-${tag} ALMACEN ORIGEN PRUEBA|`);
    expect(text).toContain(`DESTINO|DB-${tag} AULA DESTINO PRUEBA|`);
    expect(text).toContain(`FECHAS|${longSpanishDate(bogotaDate(deliveredAt))}|`);
    expect(text).toContain('ACTA|OCI-01-65||');
    expect(text).toContain('TOTALES|2|0|0|2|');
    expect(text).toContain('OBS|Devuelto con la pantalla rayada|');
    expect(text).toContain(`PORTATIL DEVOLUCION|Dañado|${longSpanishDate(bogotaDate(damagedAt))}|Bueno|`);
    expect(text).toContain('MOUSE DEVOLUCION|Bueno|');
    expect(text).toContain(`DEVUELVE|${users['contacto']?.fullName}|DOCENTE QUE DEVUELVE|`);
    expect(text).toContain(`RECIBE_ORIGEN|${users['receptor']?.fullName}|ALMACENISTA DE ORIGEN|`);

    // Firmas en el orden del formato de prueba → RETURN_ACT_SIGNED.
    const sign = (order: number, who: string) =>
      http().post(`/api/v1/documents/${act.documentId}/signatures/${order}`).set(auth(who)).send({ rubric });
    await sign(1, 'contacto').expect(200);
    await sign(2, 'receptor').expect(200);
    const signed = (await http().get(`/api/v1/loans/${loanId}`).set(auth('director')).expect(200)).body.data;
    expect(signed.returnActs[0]).toMatchObject({ status: 'SIGNED' });
    expect(signed.returnActs[0].signedAt).not.toBeNull();
    expect(signed.events.at(-1)).toMatchObject({ eventType: 'RETURN_ACT_SIGNED', performedBy: users['receptor']?.userId });
    expect(signed.status).toBe('RETURNED');
  });
});
