// Batería de privacidad (decisión del desarrollador: ningún endpoint expone activos de otro centro de costo).
// Un jefe del centro A (DEPARTMENT_HEAD asignado a A y jefatura vigente de A) recorre todos los endpoints que leen
// activos o sus datos, tomados de los controladores (assets, asset-depreciation, movements, qr-tokens, loans,
// transfers, handovers, inventories, documents, depreciation, asset-requests), contra activos del centro B. Ninguno
// debe devolver datos de B: 403/404/400 o, en listas, sin rastro de B.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { applyTrustProxy } from '../../src/common/http/trust-proxy.js';
import { createAppValidationPipe } from '../../src/common/pipes/app-validation.pipe.js';
import type { AppConfig } from '../../src/config/configuration.js';
import { TokenService } from '../../src/modules/auth/services/token.service.js';
import { PDF_CONVERTER } from '../../src/modules/documents/pdf/pdf-converter.js';
import { DocumentEngineService } from '../../src/modules/documents/services/document-engine.service.js';
import { scalar, useSharedStorage } from './helpers.js';
import { DocxTextPdfConverter } from './pdf-text.js';

const LOAN_FORMAT = 'OCI-01-65';

interface Actor {
  userId: string;
  personId: string;
  token: string;
}

interface Probe {
  readonly name: string;
  readonly method: 'get' | 'post' | 'patch' | 'put';
  readonly path: string;
  readonly body?: Record<string, unknown>;
  /** Lista: 200 permitido si no trae rastro de B. */
  readonly list?: boolean;
}

const bogotaToday = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
const plusDays = (days: number): string => {
  const date = new Date(`${bogotaToday()}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

describe('Batería de privacidad: un jefe del centro A no ve activos del centro B', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let engine: DocumentEngineService;
  let director: Actor;
  let headA: Actor;
  let headB: Actor;
  let headC: Actor;
  let contactC: Actor;
  let centerA = '';
  let centerB = '';
  let centerC = '';
  let categoryId = '';
  let templateId = '';
  const tag = randomUUID().slice(0, 6).toUpperCase();
  const secrets: string[] = [];
  const ids: Record<string, string> = {};
  const sequencesBefore: Array<{ period: string; current_value: string }> = [];
  const results: Array<[string, number, string]> = [];

  const http = () => request(app.getHttpServer());
  const auth = (who: Actor) => ({ Authorization: `Bearer ${who.token}` });

  const actor = async (first: string, role: string | null, scope: string | null, heads: ReadonlyArray<string>): Promise<Actor> => {
    const personTag = randomUUID().slice(0, 8);
    const personId = await scalar<string>(
      dataSource,
      `INSERT INTO person (first_name, last_name, email, document_type, document_number)
       VALUES ($1, 'Privacidad', $2, 'CC', $3) RETURNING id`,
      [first, `privacidad.${personTag}@unac.edu.co`, `9${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 1000)}`],
    );
    const userId = await scalar<string>(
      dataSource,
      `INSERT INTO app_user (person_id, username, password_hash, mfa_enabled, status) VALUES ($1, $2, 'x', TRUE, 'ACTIVE') RETURNING id`,
      [personId, `privacidad.${personTag}`],
    );
    if (role) {
      await dataSource.query(
        `INSERT INTO user_role (user_id, role_id, scope_type, scope_id)
         SELECT $1, id, CASE WHEN $3::uuid IS NULL THEN 'GLOBAL' ELSE 'COST_CENTER' END, $3 FROM role WHERE code = $2`,
        [userId, role, scope],
      );
    }
    for (const center of heads) {
      await dataSource.query(`INSERT INTO cost_center_head (person_id, cost_center_id, reason) VALUES ($1, $2, 'Prueba')`, [personId, center]);
    }
    const sessionId = randomUUID();
    await dataSource.query(
      `INSERT INTO refresh_token_family (id, user_id, current_jti, expires_at, mfa_verified_at) VALUES ($1, $2, $3, NOW() + interval '1 day', NOW())`,
      [sessionId, userId, randomUUID()],
    );
    const token = app.get(TokenService).signAccessToken({
      id: userId,
      personId,
      username: `privacidad.${personTag}`,
      roles: [],
      scopes: [],
      mustChangePassword: false,
      sessionId,
    });
    return { userId, personId, token };
  };

  const center = (name: string, code: string) =>
    scalar<string>(dataSource, `INSERT INTO cost_center (external_code, name) VALUES ($1, $2) RETURNING id`, [code, name]);

  const asset = async (costCenterId: string, label: string) => {
    const code = `PRV${label}${tag}`;
    const serial = `SNPRV${label}${tag}`;
    const id = await scalar<string>(
      dataSource,
      `INSERT INTO asset (internal_code, description, category_id, acquisition_type_id, acquisition_date, acquisition_price,
         serial_number, current_cost_center_id, created_by, physical_condition, operational_status)
       VALUES ($1, $2, $3, (SELECT id FROM acquisition_type WHERE code = 'PURCHASE'), '2023-01-10', 1500000, $4, $5, $6, 'GOOD', 'IN_USE')
       RETURNING id`,
      [code, `EQUIPO PRIVADO ${label} ${tag}`, categoryId, serial, costCenterId, director.userId],
    );
    return { id, code, serial };
  };

  /** Rastros de B en una respuesta: códigos, series, identificadores, descripciones o el nombre del centro B. */
  const leaks = (body: unknown): string[] => {
    const text = JSON.stringify(body ?? '');
    return secrets.filter((secret) => text.includes(secret));
  };

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
    for (const job of app.get(SchedulerRegistry).getCronJobs().values()) {
      await job.stop();
    }
    dataSource = app.get(DataSource);
    engine = app.get(DocumentEngineService);
    await useSharedStorage(dataSource);
    sequencesBefore.push(
      ...((await dataSource.query('SELECT period, current_value FROM document_sequence WHERE format_key = $1', [LOAN_FORMAT])) as typeof sequencesBefore),
    );

    centerA = await center('Centro A Privacidad', `PA${tag}`);
    centerB = await center(`Centro B Privado ${tag}`, `PB${tag}`);
    centerC = await center('Centro C Privacidad', `PC${tag}`);
    secrets.push(`Centro B Privado ${tag}`);
    categoryId = await scalar<string>(
      dataSource,
      `INSERT INTO asset_category (code, name, requires_photo) VALUES ($1, 'Privacidad', FALSE) RETURNING id`,
      [`PRV_${tag}`],
    );
    director = await actor('Directora', 'INTERNAL_CONTROL_DIRECTOR', null, []);
    headA = await actor('JefeA', 'DEPARTMENT_HEAD', centerA, [centerA]);
    headB = await actor('JefeB', 'DEPARTMENT_HEAD', centerB, [centerB]);
    headC = await actor('JefeC', 'DEPARTMENT_HEAD', centerC, [centerC]);
    contactC = await actor('ContactoC', null, null, []);
    await asset(centerA, 'A');

    // Activos de B con sus rastros: código interno, serie, identificador visible y descripción.
    const loaned = await asset(centerB, 'L');
    const transferred = await asset(centerB, 'T');
    const inventoried = await asset(centerB, 'I');
    const requested = await asset(centerB, 'R');
    for (const item of [loaned, transferred, inventoried, requested]) {
      secrets.push(item.code, item.serial, `EQUIPO PRIVADO ${item.code.slice(3, 4)} ${tag}`);
    }
    await dataSource.query(
      `INSERT INTO asset_identifier (asset_id, identifier_type, value, origin) VALUES ($1, 'VISIBLE_CODE', $2, 'IMPORTED')`,
      [loaned.id, `VISPRV${tag}`],
    );
    secrets.push(`VISPRV${tag}`);
    ids['asset'] = loaned.id;
    ids['assetCode'] = loaned.code;
    ids['assetSerial'] = loaned.serial;
    ids['transferAsset'] = transferred.id;
    ids['requestAsset'] = requested.id;
    ids['qr'] = (await http().post(`/api/v1/assets/${loaned.id}/qr`).set(auth(director)).expect(201)).body.data.token;
    ids['qrRequest'] = (await http().post(`/api/v1/assets/${requested.id}/qr`).set(auth(director)).expect(201)).body.data.token;

    // Préstamo B → C entregado, con su acta OCI-01-65 generada (movimientos, documento).
    templateId =
      (
        await engine.uploadTemplate(
          LOAN_FORMAT,
          { buffer: await readFile('templates/formats/OCI-01-65-v2.docx'), originalname: 'OCI-01-65.docx' },
          { sgcVersion: '8', effectiveDate: bogotaToday() },
          director.userId,
        )
      ).id ?? '';
    const loan = (
      await http()
        .post('/api/v1/loans')
        .set(auth(director))
        .send({
          assets: [loaned.id],
          targetCostCenterId: centerC,
          contactPerson: contactC.personId,
          expectedReturnDate: plusDays(5),
          justification: 'Préstamo de la batería',
        })
        .expect(201)
    ).body.data;
    ids['loan'] = loan.id;
    await http().post(`/api/v1/loans/${loan.id}/approve`).set(auth(headB)).expect(200);
    await http()
      .post(`/api/v1/loans/${loan.id}/deliver`)
      .set(auth(director))
      .send({ deliveredByPersonId: headB.personId, controlInternoPersonId: director.personId })
      .expect(200);
    await engine.processPending(1000);
    ids['document'] = await scalar<string>(dataSource, 'SELECT delivery_document_id FROM asset_loan WHERE id = $1', [loan.id]);
    ids['movement'] = await scalar<string>(dataSource, `SELECT id FROM asset_movement WHERE asset_id = $1 ORDER BY created_at DESC LIMIT 1`, [
      loaned.id,
    ]);

    // Traslado B → C en borrador.
    const reasonId = await scalar<string>(dataSource, `SELECT id FROM asset_transfer_reason WHERE code = 'REUBICACION'`);
    ids['transfer'] = (
      await http()
        .post('/api/v1/transfers')
        .set(auth(director))
        .send({
          items: [{ assetId: transferred.id, reasonId }],
          targetCostCenterId: centerC,
          requesterPersonId: headB.personId,
          ownerPersonId: headC.personId,
          justification: 'Traslado de la batería',
        })
        .expect(201)
    ).body.data.id;

    // Toma física del centro B, iniciada (con sus ítems).
    const inventory = await http()
      .post('/api/v1/inventories')
      .set(auth(director))
      .send({
        name: `Toma privada ${tag}`,
        scope: 'COST_CENTER',
        scopeId: centerB,
        plannedStartDate: bogotaToday(),
        plannedEndDate: plusDays(2),
        responsibleUserId: director.userId,
        reminderOffsetsDays: [],
      });
    expect(inventory.status, JSON.stringify(inventory.body)).toBe(201);
    ids['inventory'] = inventory.body.data.id;
    await http().post(`/api/v1/inventories/${ids['inventory']}/start`).set(auth(director)).send({});

    // Solicitud ajena: el jefe de C le pide a B.
    ids['request'] = (
      await http()
        .post('/api/v1/asset-requests')
        .set(auth(headC))
        .send({
          kind: 'TEMPORARY',
          requestingCostCenterId: centerC,
          ownerCostCenterId: centerB,
          description: 'Solicitud ajena de la batería',
          startDate: bogotaToday(),
          expectedReturnDate: plusDays(3),
        })
        .expect(201)
    ).body.data.id;
  });

  afterAll(async () => {
    const docs = ((await dataSource.query(`SELECT id FROM document WHERE entity_type = 'LOAN' AND entity_id = $1`, [ids['loan'] ?? null])) as Array<{
      id: string;
    }>).map((row) => row.id);
    await dataSource.query(`DELETE FROM mail_outbox WHERE entity_type = 'ASSET_REQUEST' AND entity_id = $1`, [ids['request'] ?? null]);
    await dataSource.query(`DELETE FROM notification WHERE entity_type = 'ASSET_REQUEST' AND entity_id = $1`, [ids['request'] ?? null]);
    await dataSource.query('DELETE FROM asset_request_event WHERE request_id = $1', [ids['request'] ?? null]);
    await dataSource.query('DELETE FROM asset_request_item WHERE request_id = $1', [ids['request'] ?? null]);
    await dataSource.query('DELETE FROM asset_request WHERE id = $1', [ids['request'] ?? null]);
    await dataSource.query('DELETE FROM asset_transfer_item WHERE transfer_id = $1', [ids['transfer'] ?? null]);
    await dataSource.query('DELETE FROM asset_transfer WHERE id = $1', [ids['transfer'] ?? null]);
    await dataSource.query('UPDATE asset_loan SET delivery_document_id = NULL WHERE id = $1', [ids['loan'] ?? null]);
    await dataSource.query('DELETE FROM signature_envelope_signer WHERE envelope_id IN (SELECT id FROM signature_envelope WHERE document_id = ANY($1))', [docs]);
    await dataSource.query('DELETE FROM signature_signing_link WHERE document_id = ANY($1)', [docs]);
    await dataSource.query('DELETE FROM signature_envelope WHERE document_id = ANY($1)', [docs]);
    await dataSource.query(`DELETE FROM document_request WHERE payload->>'entityType' = 'LOAN' AND payload->>'entityId' = $1`, [ids['loan'] ?? '']);
    await dataSource.query('DELETE FROM document_asset WHERE document_id = ANY($1)', [docs]);
    await dataSource.query('DELETE FROM document WHERE id = ANY($1)', [docs]);
    await dataSource.query('DELETE FROM document_template_version WHERE id = $1', [templateId || null]);
    await dataSource.query('DELETE FROM document_sequence WHERE format_key = $1', [LOAN_FORMAT]);
    for (const sequence of sequencesBefore) {
      await dataSource.query('INSERT INTO document_sequence (format_key, period, current_value) VALUES ($1, $2, $3)', [
        LOAN_FORMAT,
        sequence.period,
        sequence.current_value,
      ]);
    }
    await dataSource.query('UPDATE user_role SET revoked_at = NOW() WHERE revoked_at IS NULL AND user_id = ANY($1)', [
      [director, headA, headB, headC, contactC].map((who) => who.userId),
    ]);
    // Tabla endpoint → resultado para el reporte (PRIVACY_BATTERY_OUT=<archivo> la escribe; la consola de la suite va en silencio).
    const out = process.env['PRIVACY_BATTERY_OUT'];
    if (out) {
      await writeFile(out, results.map(([name, status, verdict]) => `| ${name} | ${status} | ${verdict} |`).join('\n'));
    }
    await app.close();
  });

  it('ningún endpoint que lee activos devuelve datos del centro B al jefe del centro A', async () => {
    const a = ids['asset'] ?? '';
    const probes: Probe[] = [
      // assets.controller.ts
      { name: 'GET /assets?q=<código interno de B>', method: 'get', path: `/assets?q=${ids['assetCode']}`, list: true },
      { name: 'GET /assets?q=<serie de B>', method: 'get', path: `/assets?q=${ids['assetSerial']}`, list: true },
      { name: 'GET /assets?q=<identificador visible de B>', method: 'get', path: `/assets?q=VISPRV${tag}`, list: true },
      { name: 'GET /assets?costCenterId=<B>', method: 'get', path: `/assets?costCenterId=${centerB}`, list: true },
      { name: 'GET /assets/:id', method: 'get', path: `/assets/${a}` },
      { name: 'GET /assets/:id/timeline', method: 'get', path: `/assets/${a}/timeline` },
      { name: 'PATCH /assets/:id', method: 'patch', path: `/assets/${a}`, body: { description: 'x' } },
      { name: 'POST /assets/:id/change-status', method: 'post', path: `/assets/${a}/change-status`, body: { status: 'IN_STORAGE', reason: 'x' } },
      { name: 'POST /assets/:id/reassign-location', method: 'post', path: `/assets/${a}/reassign-location`, body: {} },
      // asset-depreciation.controller.ts y depreciation.controller.ts
      { name: 'GET /assets/:id/depreciation-history', method: 'get', path: `/assets/${a}/depreciation-history` },
      { name: 'GET /depreciation', method: 'get', path: '/depreciation', list: true },
      { name: 'GET /depreciation/summary', method: 'get', path: '/depreciation/summary', list: true },
      // movements.controller.ts
      { name: 'GET /movements', method: 'get', path: `/movements?assetId=${a}`, list: true },
      { name: 'GET /movements/:id/verify', method: 'get', path: `/movements/${ids['movement']}/verify` },
      { name: 'GET /assets/:assetId/movements', method: 'get', path: `/assets/${a}/movements` },
      { name: 'GET /assets/:assetId/movements/export', method: 'get', path: `/assets/${a}/movements/export` },
      // qr-tokens.controller.ts
      { name: 'GET /qr/verify?token=', method: 'get', path: `/qr/verify?token=${ids['qr']}` },
      { name: 'GET /qr/verify?token=&format=png', method: 'get', path: `/qr/verify?token=${ids['qr']}&format=png` },
      { name: 'POST /qr/verify', method: 'post', path: '/qr/verify', body: { token: ids['qr'] } },
      { name: 'GET /assets/:id/qr/current', method: 'get', path: `/assets/${a}/qr/current` },
      { name: 'GET /assets/:id/qr/history', method: 'get', path: `/assets/${a}/qr/history` },
      { name: 'POST /assets/:id/qr', method: 'post', path: `/assets/${a}/qr` },
      { name: 'POST /assets/:id/qr/revoke', method: 'post', path: `/assets/${a}/qr/revoke` },
      // loans.controller.ts
      {
        name: 'POST /loans con activos de B',
        method: 'post',
        path: '/loans',
        body: {
          assets: [ids['requestAsset']],
          targetCostCenterId: centerA,
          contactPerson: headA.personId,
          expectedReturnDate: plusDays(4),
          justification: 'Intento de préstamo ajeno',
        },
      },
      { name: 'GET /loans/:id (B → C)', method: 'get', path: `/loans/${ids['loan']}` },
      { name: 'GET /loans', method: 'get', path: '/loans', list: true },
      { name: 'GET /loans/overdue', method: 'get', path: '/loans/overdue', list: true },
      { name: 'POST /loans/:id/approve', method: 'post', path: `/loans/${ids['loan']}/approve` },
      // transfers.controller.ts
      { name: 'GET /transfers/:id (B → C)', method: 'get', path: `/transfers/${ids['transfer']}` },
      { name: 'GET /transfers', method: 'get', path: '/transfers', list: true },
      {
        name: 'POST /transfers con activos de B',
        method: 'post',
        path: '/transfers',
        body: {
          items: [{ assetId: ids['requestAsset'], reasonId: randomUUID() }],
          targetCostCenterId: centerA,
          requesterPersonId: headA.personId,
          ownerPersonId: headA.personId,
          justification: 'Intento',
        },
      },
      // handovers.controller.ts
      { name: 'GET /handovers', method: 'get', path: '/handovers', list: true },
      { name: 'GET /handovers/:id', method: 'get', path: `/handovers/${randomUUID()}` },
      // inventories.controller.ts (toma del centro B)
      { name: 'GET /inventories', method: 'get', path: '/inventories', list: true },
      { name: 'GET /inventories/calendar', method: 'get', path: `/inventories/calendar?from=${plusDays(-5)}&to=${plusDays(30)}`, list: true },
      { name: 'GET /inventories/coverage', method: 'get', path: '/inventories/coverage', list: true },
      { name: 'GET /inventories/:id', method: 'get', path: `/inventories/${ids['inventory']}` },
      { name: 'GET /inventories/:id/progress', method: 'get', path: `/inventories/${ids['inventory']}/progress` },
      { name: 'GET /inventories/:id/report', method: 'get', path: `/inventories/${ids['inventory']}/report` },
      {
        name: 'POST /inventories/:id/verify-asset',
        method: 'post',
        path: `/inventories/${ids['inventory']}/verify-asset`,
        body: { assetId: ids['asset'], condition: 'GOOD' },
      },
      // documents.controller.ts (acta OCI-01-65 del préstamo B → C)
      { name: 'GET /documents', method: 'get', path: '/documents', list: true },
      { name: 'GET /documents/:id', method: 'get', path: `/documents/${ids['document']}` },
      { name: 'GET /documents/:id/pdf', method: 'get', path: `/documents/${ids['document']}/pdf` },
      { name: 'GET /documents/:id/docx', method: 'get', path: `/documents/${ids['document']}/docx` },
      // asset-requests.controller.ts (solicitud C → B, ajena al jefe de A)
      { name: 'GET /asset-requests/:id (ajena)', method: 'get', path: `/asset-requests/${ids['request']}` },
      { name: 'GET /asset-requests?box=to-decide', method: 'get', path: '/asset-requests?box=to-decide', list: true },
      { name: 'GET /asset-requests/:id/eligible-assets (ajena)', method: 'get', path: `/asset-requests/${ids['request']}/eligible-assets` },
      {
        name: 'POST /asset-requests/:id/resolve-scan (ajena)',
        method: 'post',
        path: `/asset-requests/${ids['request']}/resolve-scan`,
        body: { token: ids['qrRequest'] },
      },
      {
        name: 'POST /asset-requests/:id/accept (ajena)',
        method: 'post',
        path: `/asset-requests/${ids['request']}/accept`,
        body: { assetIds: [ids['requestAsset']] },
      },
    ];

    const failures: string[] = [];
    for (const probe of probes) {
      const call = http()[probe.method](`/api/v1${probe.path}`).set(auth(headA));
      const response = probe.body ? await call.send(probe.body) : await call;
      const body = response.headers['content-type']?.includes('json') ? response.body : response.text;
      // En listas institucionales (calendario y cobertura de tomas) el NOMBRE del centro B no es dato de sus activos.
      const found = leaks(body).filter((secret) => !(probe.list && secret === `Centro B Privado ${tag}`));
      // 503: el módulo está apagado en esta corrida (FEATURE_*): no responde nada.
      const denied = (response.status >= 400 && response.status < 500) || response.status === 503;
      const ok = found.length === 0 && (probe.list ? response.status < 500 || response.status === 503 : denied);
      const verdict = ok ? (response.status === 503 ? 'módulo apagado, sin datos' : 'sin datos de B') : `FUGA: ${found.join(', ') || `status ${response.status}`}`;
      results.push([probe.name, response.status, verdict]);
      if (!ok) {
        failures.push(`${probe.name} → ${response.status} ${found.join(', ')}`);
      }
    }

    // QR: la respuesta a un activo ajeno es idéntica a la de un token inexistente.
    const foreign = await http().get(`/api/v1/qr/verify?token=${ids['qr']}`).set(auth(headA));
    const garbage = await http().get('/api/v1/qr/verify?token=no-existe').set(auth(headA));
    expect([foreign.status, foreign.body.error]).toEqual([garbage.status, garbage.body.error]);
    // El mismo QR sí responde al jefe de B y a quien tiene alcance global; sin sesión, 401.
    expect((await http().get(`/api/v1/qr/verify?token=${ids['qr']}`).set(auth(headB))).status).toBe(200);
    expect((await http().post('/api/v1/qr/verify').set(auth(director)).send({ token: ids['qr'] })).status).toBe(200);
    expect((await http().get(`/api/v1/qr/verify?token=${ids['qr']}`)).status).toBe(401);
    // POST /loans con un activo ajeno responde igual que con uno inexistente.
    const ghost = await http()
      .post('/api/v1/loans')
      .set(auth(headA))
      .send({
        assets: [randomUUID()],
        targetCostCenterId: centerC,
        contactPerson: headA.personId,
        expectedReturnDate: plusDays(4),
        justification: 'Intento de préstamo inexistente',
      });
    const alien = await http()
      .post('/api/v1/loans')
      .set(auth(headA))
      .send({
        assets: [ids['requestAsset']],
        targetCostCenterId: centerC,
        contactPerson: headA.personId,
        expectedReturnDate: plusDays(4),
        justification: 'Intento de préstamo inexistente',
      });
    expect([alien.status, alien.body.error]).toEqual([ghost.status, ghost.body.error]);

    expect(failures).toEqual([]);
  });
});
