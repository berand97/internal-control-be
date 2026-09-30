import type { NestExpressApplication } from '@nestjs/platform-express';
import { SchedulerRegistry } from '@nestjs/schedule';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import PizZip from 'pizzip';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { createAppValidationPipe } from '../../src/common/pipes/app-validation.pipe.js';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';
import { AssetsService } from '../../src/modules/assets/services/assets.service.js';
import { TokenService } from '../../src/modules/auth/services/token.service.js';
import { PDF_CONVERTER } from '../../src/modules/documents/pdf/pdf-converter.js';
import { DocumentEngineService } from '../../src/modules/documents/services/document-engine.service.js';
import { formatMoney } from '../../src/modules/inventories/domain/inventory-act.js';
import { addDays, bogotaDate } from '../../src/modules/inventories/domain/inventory-schedule.js';
import type { StorageDriver } from '../../src/config/configuration.js';
import { StorageService } from '../../src/shared/storage/storage.service.js';
import { createPermissionRole, openTestSession, scalar, useSharedStorage } from './helpers.js';
import { DocxTextPdfConverter } from './pdf-text.js';
import { conform, type Schema } from './openapi-conform.js';

const ACT_FORMAT = 'OCI-21-37';

/** DOCX mínimo que recorre la tabla de hallazgos, la de sobrantes y los activos del acta de toma física. */
const actTemplate = (): Buffer => {
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
    'TOMA|{{campos.tomaCodigo}}|{{campos.alcance}}|{{campos.corteContable}}|',
    'TOTALES|{{campos.totalEsperados}}|{{campos.totalVerificados}}|{{campos.totalFaltantes}}|{{campos.totalSobrantes}}|',
    '{{#tablas.hallazgos}}H|{{codigo}}|{{cantidad}}|{{valorCompra}}|{{porcentaje}}|{{valorLibros}}|{{/tablas.hallazgos}}',
    '{{#tablas.sobrantes}}S|{{descripcion}}|{{resolucion}}|{{/tablas.sobrantes}}',
    '{{#activos}}A|{{codigo}}|{{campos.resultado}}|{{campos.categoria}}|{{campos.valorLibros}}|{{/activos}}',
    'FIRMAS|{{firmante.responsable.nombre}}|{{firmante.audita.nombre}}|',
    'CENTRO|{{centroCosto.codigo}}|{{campos.atendioPorArea}}|{{documento.numero}}|',
  ];
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${lines.map(paragraph).join('')}</w:body></w:document>`,
  );
  return Buffer.from(zip.generate({ type: 'nodebuffer' }));
};

const docxText = (docx: Buffer): string =>
  new PizZip(docx).file('word/document.xml')?.asText().replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '') ?? '';

interface Who {
  readonly personId: string;
  readonly userId: string;
  readonly token: string;
  readonly actor: AuthenticatedUser;
}

interface Item {
  id: string;
  assetId: string | null;
  assetCode: string | null;
  assetDescription: string | null;
  assetLegacyCode: string | null;
  result: string;
  acquisitionPrice: number | null;
  priceIsZero: boolean;
  bookValue: number | null;
  bookValueSource: string | null;
  surplusResolution: string | null;
  resolvedAssetId: string | null;
}

/**
 * Corte contable, valor en libros, sobrantes que se vuelven activo y acta OCI-21-37 contra PostgreSQL real y por
 * HTTP, con las respuestas comparadas contra el OpenAPI publicado.
 */
describe('Toma física: corte contable, valor en libros, sobrantes y acta OCI-21-37 (PostgreSQL real)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let openapi: OpenAPIObject;
  let engine: DocumentEngineService;
  let director: Who;
  let approver: Who;
  let base: { categoryId: string; acquisitionTypeId: string; roomA: string; roomB: string };
  let templateId = '';
  let sequenceBefore: string | undefined;
  const today = bogotaDate(new Date());
  const [year = 2026, month = 1] = today.split('-').map(Number);

  const http = () => request(app.getHttpServer());
  const as = (who: Who) => ({ Authorization: `Bearer ${who.token}` });
  const errorCode = (response: { body: { error?: { code?: string } } }) => response.body.error?.code;

  const expectConforms = (method: string, route: string, status: number, body: unknown) => {
    const operation = (
      openapi.paths[route] as Record<string, { responses: Record<string, { content?: Record<string, { schema: Schema }> }> }>
    )[method];
    const schema = operation?.responses[String(status)]?.content?.['application/json']?.schema;
    expect(schema, `${method.toUpperCase()} ${route} ${status} no declara esquema`).toBeDefined();
    const errors: string[] = [];
    conform(openapi, body, schema ?? {}, `${method.toUpperCase()} ${route}`, errors);
    expect(errors).toEqual([]);
  };

  const person = async (first: string, role: string | null): Promise<Who> => {
    const tag = randomUUID().slice(0, 8);
    const personId = await scalar<string>(
      dataSource,
      `INSERT INTO person (first_name, last_name, email, document_type, document_number, position_title)
       VALUES ($1, 'Valoración', $2, 'CC', $3, 'Profesional') RETURNING id`,
      [first, `${first.toLowerCase()}.${tag}@unac.edu.co`, `9${Date.now().toString().slice(-7)}${Math.floor(Math.random() * 100)}`],
    );
    const userId = await scalar<string>(
      dataSource,
      `INSERT INTO app_user (person_id, username, password_hash, status) VALUES ($1, $2, 'x', 'ACTIVE') RETURNING id`,
      [personId, `val.${tag}`],
    );
    if (role) {
      await dataSource.query(`INSERT INTO user_role (user_id, role_id, scope_type) SELECT $1, id, 'GLOBAL' FROM role WHERE code = $2`, [
        userId,
        role,
      ]);
    }
    const sessionId = await openTestSession(dataSource, userId);
    const actor: AuthenticatedUser = {
      id: userId,
      personId,
      username: `val.${tag}`,
      roles: role ? [role] : [],
      scopes: [],
      mustChangePassword: false,
    };
    const token = app.get(TokenService).signAccessToken({ ...actor, sessionId });
    return { personId, userId, token, actor };
  };

  const center = (label: string) =>
    scalar<string>(dataSource, `INSERT INTO cost_center (external_code, name) VALUES ($1, $2) RETURNING id`, [
      `IT-V${randomUUID().slice(0, 6)}`,
      label,
    ]);

  /** Jefatura vigente del centro: quien firma el acta como ENCARGADO. */
  const headOf = async (costCenterId: string, who: Who) => {
    await dataSource.query(`INSERT INTO cost_center_head (person_id, cost_center_id, reason) VALUES ($1, $2, 'Prueba')`, [
      who.personId,
      costCenterId,
    ]);
    return who;
  };

  const newAsset = async (costCenterId: string, price: number) => {
    const asset = await app.get(AssetsService).create(
      {
        categoryId: base.categoryId,
        costCenterId,
        acquisitionTypeId: base.acquisitionTypeId,
        description: `Valoración ${randomUUID().slice(0, 6)}`,
        acquisitionDate: '2021-01-01',
        acquisitionPrice: price,
        locationId: base.roomA,
      },
      director.actor,
    );
    return asset.id;
  };

  const depreciation = (assetId: string, periodYear: number, periodMonth: number, bookValue: number) =>
    dataSource.query(
      `INSERT INTO asset_depreciation (asset_id, period_year, period_month, method, monthly_depreciation,
         accumulated_depreciation, book_value)
       VALUES ($1, $2, $3, 'STRAIGHT_LINE', 10, 100, $4)`,
      [assetId, periodYear, periodMonth, bookValue],
    );

  const schedule = async (costCenterId: string, responsible: Who) => {
    const response = await http()
      .post('/api/v1/inventories')
      .set(as(director))
      .send({
        name: 'Toma de valoración',
        scope: 'COST_CENTER',
        scopeId: costCenterId,
        plannedStartDate: today,
        plannedEndDate: addDays(today, 2),
        responsibleUserId: responsible.userId,
        reminderOffsetsDays: [],
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body.data.id as string;
  };

  const post = (who: Who, path: string, body: Record<string, unknown> = {}) =>
    http().post(`/api/v1/inventories${path}`).set(as(who)).send(body);

  const detail = async (id: string) => {
    const response = await http().get(`/api/v1/inventories/${id}`).set(as(director)).expect(200);
    expectConforms('get', '/api/v1/inventories/{id}', 200, response.body);
    return response.body.data as {
      status: string;
      items: Item[];
      reconciliationBasis: Record<string, unknown>;
      act: Record<string, unknown>;
    };
  };

  const itemOf = (items: Item[], assetId: string) => items.find((item) => item.assetId === assetId) as Item;

  /** Programa, inicia y deja la toma lista para verificar. */
  const started = async (costCenterId: string, responsible: Who = director) => {
    const id = await schedule(costCenterId, responsible);
    expect((await post(responsible, `/${id}/start`)).status).toBe(200);
    return id;
  };

  const closeAndApprove = async (id: string, responsible: Who) => {
    const closed = await post(responsible, `/${id}/close`, { allowUnverified: true });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect((await post(responsible, `/${id}/reconcile`)).status).toBe(200);
    const approved = await post(approver, `/${id}/reconcile/approve`);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expectConforms('post', '/api/v1/inventories/{id}/reconcile/approve', 200, approved.body);
    return approved.body.data as { status: string; act: Record<string, unknown> };
  };

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
    engine = app.get(DocumentEngineService);
    await useSharedStorage(dataSource);
    openapi = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    sequenceBefore = await scalar<string | undefined>(
      dataSource,
      `SELECT current_value FROM document_sequence WHERE format_key = $1 AND period = ''`,
      [ACT_FORMAT],
    );
    const campus = await scalar<string>(dataSource, `INSERT INTO campus (code, name) VALUES ('IT-VC', 'Sede valoración') RETURNING id`);
    const building = await scalar<string>(
      dataSource,
      `INSERT INTO building (campus_id, code, name) VALUES ($1, 'IT-VB', 'Bloque valoración') RETURNING id`,
      [campus],
    );
    const room = (code: string) =>
      scalar<string>(
        dataSource,
        `INSERT INTO location (building_id, code, name, location_type) VALUES ($1, $2, $2, 'OFFICE') RETURNING id`,
        [building, code],
      );
    base = {
      categoryId: await scalar<string>(
        dataSource,
        `INSERT INTO asset_category (code, name, requires_photo) VALUES ('IT_VALUE', 'Categoría valoración', FALSE) RETURNING id`,
      ),
      acquisitionTypeId: await scalar<string>(dataSource, `SELECT id FROM acquisition_type WHERE code = 'PURCHASE'`),
      roomA: await room('IT-V101'),
      roomB: await room('IT-V102'),
    };
    director = await person('Directora', 'INTERNAL_CONTROL_DIRECTOR');
    approver = await person('Aprobador', 'INTERNAL_CONTROL_DIRECTOR');
  });

  afterAll(async () => {
    // Deja la BD compartida como estaba: OCI-21-37 sin plantilla, sin actas ni solicitudes de tomas, y su consecutivo.
    await dataSource.query('UPDATE physical_inventory_act SET document_request_id = NULL, document_id = NULL');
    const ids = (
      (await dataSource.query(`SELECT id FROM document WHERE entity_type = 'PHYSICAL_INVENTORY_ACT'`)) as Array<{ id: string }>
    ).map((row) => row.id);
    await dataSource.query('DELETE FROM document_signature_reassignment WHERE document_id = ANY($1)', [ids]);
    await dataSource.query(
      'DELETE FROM signature_envelope_signer WHERE envelope_id IN (SELECT id FROM signature_envelope WHERE document_id = ANY($1))',
      [ids],
    );
    await dataSource.query('DELETE FROM signature_signing_link WHERE document_id = ANY($1)', [ids]);
    await dataSource.query('DELETE FROM signature_envelope WHERE document_id = ANY($1)', [ids]);
    await dataSource.query(`DELETE FROM document_request WHERE payload->>'entityType' = 'PHYSICAL_INVENTORY_ACT'`);
    await dataSource.query('DELETE FROM document WHERE id = ANY($1)', [ids]);
    await dataSource.query('DELETE FROM document_template_version WHERE id = $1', [templateId || null]);
    await dataSource.query(`DELETE FROM document_sequence WHERE format_key = $1`, [ACT_FORMAT]);
    if (sequenceBefore !== undefined) {
      await dataSource.query(`INSERT INTO document_sequence (format_key, period, current_value) VALUES ($1, '', $2)`, [
        ACT_FORMAT,
        sequenceBefore,
      ]);
    }
    // Otros archivos esperan asset_depreciation vacía (la depreciación está apagada por defecto).
    await dataSource.query(
      `DELETE FROM asset_depreciation WHERE asset_id IN (SELECT id FROM asset WHERE category_id = $1)`,
      [base.categoryId],
    );
    await dataSource.query('DROP TRIGGER IF EXISTS it_fail_surplus ON asset_movement');
    await dataSource.query('DROP FUNCTION IF EXISTS it_fail_surplus()');
    await app.close();
  });

  it('con corte asociado: la base es el corte; valor en libros de su línea, si no de la depreciación hasta la fecha del corte, y nunca 0 inventado', async () => {
    const centerId = await center('Centro con corte');
    const fromCut = await newAsset(centerId, 1000);
    const zeroPrice = await newAsset(centerId, 0);
    const noData = await newAsset(centerId, 250);
    await depreciation(zeroPrice, 2026, 5, 50);
    // Posterior al corte: no cuenta.
    await depreciation(zeroPrice, 2026, 8, 30);
    // La línea del corte prevalece sobre la depreciación.
    await depreciation(fromCut, 2026, 4, 900);

    const created = await http()
      .post('/api/v1/accounting-cuts')
      .set(as(director))
      .send({ cutDate: '2026-06-30', sourceLabel: 'Reporte de Contabilidad junio 2026', notes: 'Prueba' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expectConforms('post', '/api/v1/accounting-cuts', 201, created.body);
    const cutId = created.body.data.id as string;
    expect(created.body.data).toMatchObject({ cutDate: '2026-06-30', sourceKind: 'MANUAL', lineCount: 0 });
    await dataSource.query(
      `INSERT INTO accounting_cut_line (cut_id, line_number, asset_ref, asset_id, book_value, acquisition_price)
       VALUES ($1, 1, 'A-1', $2, 700, 1000), ($1, 2, 'A-3', $3, NULL, 250)`,
      [cutId, fromCut, noData],
    );
    const list = await http().get('/api/v1/accounting-cuts').set(as(director)).expect(200);
    expectConforms('get', '/api/v1/accounting-cuts', 200, list.body);
    expect(list.body.data.find((cut: { id: string }) => cut.id === cutId)).toMatchObject({ lineCount: 2 });

    const id = await schedule(centerId, director);
    const linked = await http()
      .put(`/api/v1/inventories/${id}/accounting-cut`)
      .set(as(director))
      .send({ accountingCutId: cutId });
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    expectConforms('put', '/api/v1/inventories/{id}/accounting-cut', 200, linked.body);
    expect(linked.body.data.reconciliationBasis).toMatchObject({
      kind: 'ACCOUNTING_CUT',
      cutId,
      cutDate: '2026-06-30',
      sourceLabel: 'Reporte de Contabilidad junio 2026',
      valuationDate: '2026-06-30',
    });
    // Sin el permiso de programar no se asocia.
    const outsider = await person('Ajena', 'DEPARTMENT_HEAD');
    expect((await http().put(`/api/v1/inventories/${id}/accounting-cut`).set(as(outsider)).send({ accountingCutId: null })).status).toBe(403);

    expect((await post(director, `/${id}/start`)).status).toBe(200);
    const view = await detail(id);
    expect(view.reconciliationBasis).toMatchObject({ kind: 'ACCOUNTING_CUT', cutDate: '2026-06-30', snapshotDate: today });
    expect(view.reconciliationBasis['snapshotAt']).not.toBeNull();
    expect(itemOf(view.items, fromCut)).toMatchObject({
      acquisitionPrice: 1000,
      priceIsZero: false,
      bookValue: 700,
      bookValueSource: 'ACCOUNTING_CUT',
    });
    expect(itemOf(view.items, zeroPrice)).toMatchObject({
      acquisitionPrice: 0,
      priceIsZero: true,
      bookValue: 50,
      bookValueSource: 'DEPRECIATION',
    });
    expect(itemOf(view.items, noData)).toMatchObject({ acquisitionPrice: 250, bookValue: null, bookValueSource: null });
    const internalCode = await scalar<string>(dataSource, 'SELECT internal_code FROM asset WHERE id = $1', [fromCut]);
    expect(itemOf(view.items, fromCut)).toMatchObject({
      assetCode: internalCode,
      assetDescription: expect.stringMatching(/^Valoración /),
      assetLegacyCode: null,
    });

    const report = await http().get(`/api/v1/inventories/${id}/report`).set(as(director)).expect(200);
    expectConforms('get', '/api/v1/inventories/{id}/report', 200, report.body);
    expect(report.body.data.reconciliationBasis.kind).toBe('ACCOUNTING_CUT');

    // Cerrada, el corte ya no cambia, y el reporte congelado sigue trayendo la valoración en vivo.
    expect((await post(director, `/${id}/close`, { allowUnverified: true })).status).toBe(200);
    const late = await http().put(`/api/v1/inventories/${id}/accounting-cut`).set(as(director)).send({ accountingCutId: null });
    expect(late.status).toBe(406);
    expect(errorCode(late)).toBe('INVALID_STATE');
    const frozen = await http().get(`/api/v1/inventories/${id}/report`).set(as(director)).expect(200);
    expectConforms('get', '/api/v1/inventories/{id}/report', 200, frozen.body);
    const notVerified = frozen.body.data.notVerifiedItems as Item[];
    expect(itemOf(notVerified, fromCut)).toMatchObject({ bookValue: 700, bookValueSource: 'ACCOUNTING_CUT' });
  });

  it('sin corte: la base es la foto del sistema y el valor en libros sale de la depreciación hasta la foto o queda null', async () => {
    const centerId = await center('Centro sin corte');
    const depreciated = await newAsset(centerId, 800);
    const empty = await newAsset(centerId, 0);
    const previous = month === 1 ? { y: year - 1, m: 12 } : { y: year, m: month - 1 };
    await depreciation(depreciated, previous.y, previous.m, 123.45);
    await depreciation(depreciated, year + 1, 1, 1);
    const id = await started(centerId);
    const view = await detail(id);
    expect(view.reconciliationBasis).toMatchObject({
      kind: 'SYSTEM_SNAPSHOT',
      cutId: null,
      cutDate: null,
      sourceLabel: null,
      snapshotDate: today,
      valuationDate: today,
    });
    expect(itemOf(view.items, depreciated)).toMatchObject({ bookValue: 123.45, bookValueSource: 'DEPRECIATION' });
    expect(itemOf(view.items, empty)).toMatchObject({
      acquisitionPrice: 0,
      priceIsZero: true,
      bookValue: null,
      bookValueSource: null,
    });
    expect(view.act).toMatchObject({ generation: 'NONE', reason: null, retryable: false });
  });

  it('sobrante → activo: con la toma cerrada, en el centro de la toma, con su movimiento en una transacción; LOST no pasa y un fallo no deja nada', async () => {
    const centerId = await center('Centro sobrantes');
    await newAsset(centerId, 100);
    const lostAsset = await newAsset(await center('Centro del perdido'), 90);
    await dataSource.query(`UPDATE asset SET operational_status = 'LOST' WHERE id = $1`, [lostAsset]);
    const id = await started(centerId);
    const surplus = await post(director, `/${id}/report-unexpected`, {
      notes: 'Silla sin placa',
      locationId: base.roomB,
      condition: 'GOOD',
    });
    expect(surplus.status).toBe(200);
    const surplusId = surplus.body.data.id as string;
    const lost = await post(director, `/${id}/report-unexpected`, { assetId: lostAsset, condition: 'FAIR' });
    expect(lost.body.data.wasLost).toBe(true);

    const asset = {
      description: 'Silla ergonómica sin placa',
      categoryId: base.categoryId,
      acquisitionTypeId: base.acquisitionTypeId,
      acquisitionDate: '2024-02-10',
      acquisitionPrice: 350000,
    };
    const early = await post(director, `/${id}/items/${surplusId}/resolve-surplus`, { action: 'CREATE_ASSET', reason: 'Se registra', asset });
    expect(early.status).toBe(406);
    expect(errorCode(early)).toBe('INVALID_STATE');

    expect((await post(director, `/${id}/close`, { allowUnverified: true })).status).toBe(200);

    const wasLost = await post(director, `/${id}/items/${lost.body.data.id}/resolve-surplus`, {
      action: 'CREATE_ASSET',
      reason: 'Se registra',
      asset,
    });
    expect(wasLost.status).toBe(406);
    expect(errorCode(wasLost)).toBe('INVENTORY_SURPLUS_WAS_LOST');

    const withoutAsset = await post(director, `/${id}/items/${surplusId}/resolve-surplus`, { action: 'CREATE_ASSET', reason: 'Falta' });
    expect(withoutAsset.status).toBe(400);
    const otherCenter = await post(director, `/${id}/items/${surplusId}/resolve-surplus`, {
      action: 'CREATE_ASSET',
      reason: 'Otro centro',
      costCenterId: await center('Centro ajeno'),
      asset,
    });
    expect(otherCenter.status).toBe(400);

    const left = await post(director, `/${id}/items/${surplusId}/resolve-surplus`, {
      action: 'LEAVE_UNRESOLVED',
      reason: 'Se espera la factura',
    });
    expect(left.status, JSON.stringify(left.body)).toBe(200);
    expectConforms('post', '/api/v1/inventories/{id}/items/{itemId}/resolve-surplus', 200, left.body);
    expect(left.body.data).toMatchObject({ surplusResolution: 'LEAVE_UNRESOLVED', resolvedAssetId: null, assetCode: null, surplusCostCenterId: null });
    // En una toma por centro el sobrante ya es de ese centro: no se elige otro.
    const ownCenter = await http().put(`/api/v1/inventories/${id}/items/${surplusId}/surplus-center`).set(as(director)).send({ costCenterId: await center('Centro elegido') });
    expect([ownCenter.status, ownCenter.body.error.code]).toEqual([406, 'INVALID_STATE']);

    // Un fallo al registrar el movimiento revierte también el activo y la resolución.
    await dataSource.query(`
      CREATE FUNCTION it_fail_surplus() RETURNS trigger AS $$
      BEGIN
        IF NEW.reason LIKE '%FALLO-SIMULADO%' THEN RAISE EXCEPTION 'fallo simulado del movimiento'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await dataSource.query(
      'CREATE TRIGGER it_fail_surplus BEFORE INSERT ON asset_movement FOR EACH ROW EXECUTE FUNCTION it_fail_surplus()',
    );
    const failing = await post(director, `/${id}/items/${surplusId}/resolve-surplus`, {
      action: 'CREATE_ASSET',
      reason: 'FALLO-SIMULADO',
      asset: { ...asset, description: 'Activo que no debe quedar' },
    });
    expect(failing.status).toBe(500);
    expect(await scalar<number>(dataSource, `SELECT count(*)::int FROM asset WHERE description = 'Activo que no debe quedar'`)).toBe(0);
    expect(
      await scalar<string>(dataSource, 'SELECT surplus_resolution FROM physical_inventory_item WHERE id = $1', [surplusId]),
    ).toBe('LEAVE_UNRESOLVED');
    await dataSource.query('DROP TRIGGER it_fail_surplus ON asset_movement');
    await dataSource.query('DROP FUNCTION it_fail_surplus()');

    const createdResponse = await post(director, `/${id}/items/${surplusId}/resolve-surplus`, {
      action: 'CREATE_ASSET',
      reason: 'Sin placa, se registra',
      asset,
    });
    expect(createdResponse.status, JSON.stringify(createdResponse.body)).toBe(200);
    expectConforms('post', '/api/v1/inventories/{id}/items/{itemId}/resolve-surplus', 200, createdResponse.body);
    const resolved = createdResponse.body.data as Item & { resolvedBy: string };
    expect(resolved).toMatchObject({
      assetId: null,
      surplusResolution: 'CREATE_ASSET',
      resolvedBy: director.userId,
      resolvedByName: 'Directora Valoración',
      acquisitionPrice: 350000,
      bookValue: null,
      assetDescription: 'Silla ergonómica sin placa',
    });
    const [createdAsset] = (await dataSource.query(
      `SELECT a.current_cost_center_id, a.current_location_id, a.physical_condition, a.description,
              m.movement_type, m.reason, m.document_reference, m.metadata->>'inventoryId' AS inventory_id
       FROM asset a JOIN asset_movement m ON m.asset_id = a.id WHERE a.id = $1`,
      [resolved.resolvedAssetId],
    )) as Array<Record<string, string>>;
    const code = await scalar<string>(dataSource, 'SELECT code FROM physical_inventory WHERE id = $1', [id]);
    expect(createdAsset).toMatchObject({
      current_cost_center_id: centerId,
      current_location_id: base.roomB,
      physical_condition: 'GOOD',
      description: 'Silla ergonómica sin placa',
      movement_type: 'REGISTRATION',
      document_reference: code,
      inventory_id: id,
    });
    expect(createdAsset?.['reason']).toContain(`Alta por sobrante de la toma ${code}`);

    const again = await post(director, `/${id}/items/${surplusId}/resolve-surplus`, { action: 'CREATE_ASSET', reason: 'Otra vez', asset });
    expect(errorCode(again)).toBe('INVENTORY_SURPLUS_NOT_RESOLVABLE');
  });

  it('aprobar sin plantilla: la toma queda RECONCILED y el acta falla con TEMPLATE_NOT_ACTIVE; con el formato sin código SGC queda NOT_ENQUEUED y se encola después', async () => {
    const centerId = await center('Centro sin plantilla');
    await newAsset(centerId, 10);
    await headOf(centerId, await person('Jefa', null));
    const responsible = await person('Responsable', 'INTERNAL_CONTROL_DIRECTOR');
    const id = await started(centerId, responsible);
    const approved = await closeAndApprove(id, responsible);
    expect(approved.status).toBe('RECONCILED');
    expect(approved.act).toMatchObject({ generation: 'PENDING', reason: null });
    await engine.processPending(1000);
    const failed = await detail(id);
    expect(failed.status).toBe('RECONCILED');
    expect(failed.act).toMatchObject({
      generation: 'FAILED',
      reason: 'TEMPLATE_NOT_ACTIVE',
      retryable: true,
      retryAction: 'RETRY_REQUEST',
      retriesAutomatically: true,
      documentId: null,
    });

    // Formato sin código SGC (decisión pendiente de Control Interno): la conciliación sigue y el acta no se encola.
    // Las versiones no se modifican: una versión nueva vigente hoy, sin código ni firmantes, que se borra al final.
    const unissued = await scalar<string>(
      dataSource,
      `INSERT INTO document_format_version (format_key, version_number, sgc_code, sgc_version, name, effective_from,
         numbering_width, numbering_per_year, numbering_last_issued, numbering_last_issued_period, pending_decisions,
         change_reason)
       SELECT format_key, version_number + 1, NULL, NULL, name, $2::date, numbering_width, numbering_per_year,
              numbering_last_issued, numbering_last_issued_period, '[]', 'Prueba: formato sin emitir'
       FROM document_format_version WHERE format_key = $1 ORDER BY version_number DESC LIMIT 1
       RETURNING id`,
      [ACT_FORMAT, today],
    );
    const restore = () => dataSource.query('DELETE FROM document_format_version WHERE id = $1', [unissued]);
    try {
      const otherCenter = await center('Centro sin formato');
      await newAsset(otherCenter, 10);
      const otherHead = await headOf(otherCenter, await person('Jefe', null));
      const orphan = await started(otherCenter, responsible);
      const reconciled = await closeAndApprove(orphan, responsible);
      expect(reconciled.status).toBe('RECONCILED');
      expect(reconciled.act).toMatchObject({
        generation: 'NOT_ENQUEUED',
        reason: 'FORMAT_NOT_READY',
        retryable: true,
        retryAction: 'ENQUEUE',
        requestId: null,
      });
      expect(String(reconciled.act['message'])).toContain('sin código SGC institucional');
      expect(
        await scalar<number>(dataSource, `SELECT count(*)::int FROM document_request WHERE payload->>'entityId' IN (SELECT id::text FROM physical_inventory_act WHERE inventory_id = $1)`, [orphan]),
      ).toBe(0);
      const blocked = await post(director, `/${orphan}/act/enqueue`);
      expect(blocked.status).toBe(409);
      expect(errorCode(blocked)).toBe('DOCUMENT_FORMAT_NOT_READY');
      expect(blocked.body.error.details).toEqual([{ field: 'reason', message: 'FORMAT_NOT_READY' }]);
      // Encolar exige el permiso de programar tomas.
      const custodian = await person('Custodia', 'DEPARTMENT_HEAD');
      expect((await post(custodian, `/${orphan}/act/enqueue`)).status).toBe(403);

      await restore();
      const enqueued = await post(director, `/${orphan}/act/enqueue`);
      expect(enqueued.status, JSON.stringify(enqueued.body)).toBe(200);
      expectConforms('post', '/api/v1/inventories/{id}/act/enqueue', 200, enqueued.body);
      expect(enqueued.body.data).toMatchObject({ generation: 'PENDING', reason: null, blockedAt: null });
      const [payload] = (await dataSource.query(
        `SELECT payload FROM document_request WHERE payload->>'entityId' IN (SELECT id::text FROM physical_inventory_act WHERE inventory_id = $1)`,
        [orphan],
      )) as Array<{ payload: { signers: Record<string, string>; responsiblePersonId: string; costCenterId: string } }>;
      // AUDITA es quien aprobó la conciliación, no quien reintenta; RESPONSABLE (ENCARGADO) es el jefe del centro.
      expect(payload?.payload).toMatchObject({
        signers: { AUDITA: approver.personId },
        responsiblePersonId: otherHead.personId,
        costCenterId: otherCenter,
      });
      expect((await post(director, `/${orphan}/act/enqueue`)).status).toBe(406);
    } finally {
      await restore();
    }
  });

  it('con plantilla: el acta se genera con la tabla de hallazgos (conteos, valores y "Sin dato") y los sobrantes', async () => {
    const uploaded = await engine.uploadTemplate(
      ACT_FORMAT,
      { buffer: actTemplate(), originalname: 'acta-toma.docx' },
      { sgcVersion: '9', effectiveDate: today },
      director.userId,
    );
    templateId = uploaded.id ?? '';
    const centerId = await center('Centro con acta');
    const first = await newAsset(centerId, 1000);
    const second = await newAsset(centerId, 500);
    const missing = await newAsset(centerId, 200);
    await depreciation(first, 2020, 12, 800);
    await depreciation(second, 2020, 12, 300);
    await headOf(centerId, await person('Jefa', null));
    const responsible = await person('Responsable', 'INTERNAL_CONTROL_DIRECTOR');
    const id = await started(centerId, responsible);
    const view = await detail(id);
    const itemId = (assetId: string) => itemOf(view.items, assetId).id;
    for (const assetId of [first, second]) {
      expect((await post(responsible, `/${id}/verify-asset`, { assetId, condition: 'GOOD' })).status).toBe(200);
    }
    expect((await post(responsible, `/${id}/report-not-found`, { assetId: missing, otherCause: 'Se desconoce' })).status).toBe(200);
    for (const [assetId, code] of [
      [first, 'AU'],
      [second, 'AU'],
      [missing, 'ANE'],
    ] as const) {
      const set = await http()
        .put(`/api/v1/inventories/${id}/items/${itemId(assetId)}/finding-category`)
        .set(as(responsible))
        .send({ code });
      expect(set.status, JSON.stringify(set.body)).toBe(200);
    }
    expect((await post(responsible, `/${id}/report-unexpected`, { notes: 'Mesa sin placa' })).status).toBe(200);
    const approved = await closeAndApprove(id, responsible);
    expect(approved.act).toMatchObject({ generation: 'PENDING' });
    await engine.processPending(1000);
    const generated = await detail(id);
    expect(generated.act).toMatchObject({ generation: 'GENERATED', reason: null, retryable: false, status: 'PENDING_SIGNATURE' });
    expect(generated.act['number']).toEqual(expect.any(String));
    // Toma por centro de costo: una sola acta, la de su centro.
    expect((generated as unknown as { acts: Array<{ costCenter: { id: string } }> }).acts.map((act) => act.costCenter.id)).toEqual([centerId]);

    const [row] = (await dataSource.query(
      'SELECT docx_driver, docx_key, entity_type, entity_id FROM document WHERE id = $1',
      [generated.act['documentId']],
    )) as Array<{ docx_driver: StorageDriver; docx_key: string; entity_type: string; entity_id: string }>;
    expect(row).toMatchObject({
      entity_type: 'PHYSICAL_INVENTORY_ACT',
      entity_id: await scalar<string>(dataSource, 'SELECT id FROM physical_inventory_act WHERE inventory_id = $1', [id]),
    });
    expect(
      await scalar<string>(dataSource, 'SELECT document_id FROM physical_inventory_act WHERE inventory_id = $1', [id]),
    ).toBe(generated.act['documentId']);
    const text = docxText(await app.get(StorageService).getFrom(row?.docx_driver ?? 'project', row?.docx_key ?? ''));
    const code = await scalar<string>(dataSource, 'SELECT code FROM physical_inventory WHERE id = $1', [id]);
    expect(text).toContain(`TOMA|${code}|Centro de costo `);
    expect(text).toContain('|Sin corte contable: estado del sistema al ');
    expect(text).toContain('TOTALES|3|2|1|1|');
    // Porcentaje sobre el precio de compra: 1500 / 1700 y 200 / 1700 (no 2 y 1 de 3 bienes).
    expect(text).toContain(`H|AU|2|${formatMoney(1500)}|88,24 %|${formatMoney(1100)}|`);
    expect(text).toContain(`H|ANE|1|${formatMoney(200)}|11,76 %|Sin dato|`);
    expect(text).toContain(`H|AOD|0|${formatMoney(0)}|0,00 %|${formatMoney(0)}|`);
    expect(text).toContain(`H|TOTAL|3|${formatMoney(1700)}|100,00 %|Sin dato|`);
    expect(text).toContain('1.500,00');
    expect(text).toContain('S|Mesa sin placa|Sin decisión|');
    expect(text).toContain('|Encontrado|Activos en uso|');
    expect(text).toContain('|No encontrado|Activos no encontrados|Sin dato|');
    // ENCARGADO = jefe vigente del centro de la toma, no el responsable de la toma.
    expect(text).toContain('FIRMAS|Jefa Valoración|Aprobador Valoración|');
  });
  it('separación de funciones: si quien aprueba es el jefe que firma como ENCARGADO, el acta queda sin encolar hasta indicar un sustituto de Control Interno', async () => {
    const centerId = await center('Centro con conflicto de firmas');
    await newAsset(centerId, 10);
    // El aprobador es a la vez el jefe del centro de la toma: firmaría RESPONSABLE (ENCARGADO) y AUDITA.
    await headOf(centerId, approver);
    const id = await started(centerId);
    expect((await post(director, `/${id}/close`, { allowUnverified: true })).status).toBe(200);
    const reconcile = await post(director, `/${id}/reconcile`);
    expect(reconcile.status, JSON.stringify(reconcile.body)).toBe(200);
    const approved = await post(approver, `/${id}/reconcile/approve`);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data.status).toBe('RECONCILED');
    expect(approved.body.data.act).toMatchObject({ generation: 'NOT_ENQUEUED', reason: 'ENQUEUE_FAILED', retryAction: 'ENQUEUE' });
    expect(String(approved.body.data.act.message)).toContain('Separación de funciones');

    // Encolado manual: los errores de separación de funciones salen tal cual, como en entregas, préstamos y traslados.
    const duplicated = await post(director, `/${id}/act/enqueue`);
    expect([duplicated.status, duplicated.body.error.code]).toEqual([409, 'DOCUMENT_SIGNER_DUPLICATED']);
    expect(duplicated.body.error.message).toContain('Separación de funciones');
    expect(duplicated.body.error.details.map((item: { field: string }) => item.field)).toEqual(
      expect.arrayContaining(['signers.RESPONSABLE', 'signers.AUDITA', 'signerSubstitutions.AUDITA']),
    );
    const withoutRole = await person('SinRol', null);
    const invalid = await post(director, `/${id}/act/enqueue`, {
      signerSubstitutions: { AUDITA: { personId: withoutRole.personId, reason: 'El responsable aprobó la conciliación' } },
    });
    expect([invalid.status, invalid.body.error.code]).toEqual([400, 'DOCUMENT_SIGNER_SUBSTITUTE_INVALID']);
    expect(invalid.body.error.message).toContain('Firmar actas por Control Interno');
    // Nada cambió: el acta sigue sin encolar, con el motivo de la aprobación.
    expect((await detail(id)).act).toMatchObject({ generation: 'NOT_ENQUEUED', reason: 'ENQUEUE_FAILED', retryAction: 'ENQUEUE' });
    const enqueued = await post(director, `/${id}/act/enqueue`, {
      signerSubstitutions: { AUDITA: { personId: director.personId, reason: 'El responsable aprobó la conciliación' } },
    });
    expect(enqueued.status, JSON.stringify(enqueued.body)).toBe(200);
    expect(enqueued.body.data).toMatchObject({ generation: 'PENDING' });
    await engine.processPending(1000);
    const generated = await detail(id);
    expect(generated.act).toMatchObject({ generation: 'GENERATED' });
    const firmante = await scalar<Record<string, { nombre: string; sustitucion?: Record<string, string> }>>(
      dataSource,
      `SELECT data->'firmante' FROM document WHERE id = $1`,
      [generated.act['documentId']],
    );
    expect(firmante['audita']?.sustitucion).toMatchObject({ motivo: 'El responsable aprobó la conciliación', rol: 'Control Interno' });
    expect(firmante['responsable']?.nombre).toBe(firmante['audita']?.sustitucion?.['nombre']);
  });

  it('regla del firmante de Control Interno: si quien aprueba no tiene act:sign_control:global, la conciliación sigue y el acta queda sin encolar hasta un sustituto', async () => {
    // Aprueba conciliaciones (inventory:reconcile:global) pero no firma por Control Interno.
    const reconciler = await person(
      'Conciliadora',
      await createPermissionRole(dataSource, ['inventory:reconcile:global', 'inventory:read:global'], 'IT_CONCILIA'),
    );
    const centerId = await center('Centro con aprobador sin permiso de firma');
    await newAsset(centerId, 10);
    await headOf(centerId, await person('Jefe', null));
    const id = await started(centerId);
    expect((await post(director, `/${id}/close`, { allowUnverified: true })).status).toBe(200);
    expect((await post(director, `/${id}/reconcile`)).status).toBe(200);
    const approved = await post(reconciler, `/${id}/reconcile/approve`);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data.status).toBe('RECONCILED');
    expect(approved.body.data.act).toMatchObject({ generation: 'NOT_ENQUEUED', reason: 'ENQUEUE_FAILED', retryAction: 'ENQUEUE' });
    expect(String(approved.body.data.act.message)).toContain('Firmar actas por Control Interno');

    // Reencolar sin sustituto: el error sale tal cual, con el rol del turno en details.
    const notEligible = await post(director, `/${id}/act/enqueue`);
    expect([notEligible.status, notEligible.body.error.code]).toEqual([400, 'DOCUMENT_SIGNER_NOT_ELIGIBLE']);
    expect(notEligible.body.error.details).toEqual([{ field: 'signers.AUDITA', message: expect.stringContaining('act:sign_control:global') }]);
    // Con un sustituto que sí tiene el permiso: se encola.
    const enqueued = await post(director, `/${id}/act/enqueue`, {
      signerSubstitutions: { AUDITA: { personId: approver.personId, reason: 'Quien aprobó no firma por Control Interno' } },
    });
    expect(enqueued.status, JSON.stringify(enqueued.body)).toBe(200);
    expect(enqueued.body.data).toMatchObject({ generation: 'PENDING' });
  });

  it('firmante ENCARGADO al cerrar: un jefe firma él; varios, se elige; ninguno, aviso y acta sin emitir hasta asignar y reencolar; quién atendió es aparte', async () => {
    const payloadOf = async (id: string) =>
      (
        (await dataSource.query(`SELECT payload FROM document_request WHERE payload->>'entityId' IN (SELECT id::text FROM physical_inventory_act WHERE inventory_id = $1)`, [id])) as Array<{
          payload: { responsiblePersonId: string; fields: Record<string, string> };
        }>
      )[0]?.payload;
    const put = (who: Who, path: string, body: Record<string, unknown>) =>
      http().put(`/api/v1/inventories${path}`).set(as(who)).send(body);
    const approve = async (id: string) => {
      expect((await post(director, `/${id}/reconcile`)).status).toBe(200);
      const approved = await post(approver, `/${id}/reconcile/approve`);
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      return approved.body.data as { act: Record<string, unknown>; warnings: unknown[] };
    };

    // Un jefe vigente: firma él sin elegir. Atendió una persona del sistema (informativo, no firma).
    const single = await center('Centro con un jefe');
    await newAsset(single, 10);
    const onlyHead = await headOf(single, await person('Único', null));
    const assistant = await person('Asistente', null);
    const first = await started(single);
    const closed = await post(director, `/${first}/close`, { allowUnverified: true, attendedByPersonId: assistant.personId });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expectConforms('post', '/api/v1/inventories/{id}/close', 200, closed.body);
    expect(closed.body.data).toMatchObject({
      signerHead: { personId: onlyHead.personId, name: 'Único Valoración' },
      attendedBy: { personId: assistant.personId, name: 'Asistente Valoración' },
      actIssuable: true,
      warnings: [],
    });
    await approve(first);
    expect(await payloadOf(first)).toMatchObject({
      responsiblePersonId: onlyHead.personId,
      fields: { atendioPorArea: 'Asistente Valoración' },
    });

    // Varios jefes: hay que elegir, y solo entre ellos. Atendió alguien sin usuario: texto libre.
    const shared = await center('Centro con dos jefes');
    await newAsset(shared, 10);
    const headA = await headOf(shared, await person('Jefa A', null));
    const headB = await headOf(shared, await person('Jefe B', null));
    const second = await started(shared);
    const candidates = await http().get(`/api/v1/inventories/${second}/head-candidates`).set(as(director)).expect(200);
    expectConforms('get', '/api/v1/inventories/{id}/head-candidates', 200, candidates.body);
    expect(candidates.body.data.map((row: { personId: string }) => row.personId).sort()).toEqual([headA.personId, headB.personId].sort());
    for (const row of candidates.body.data as Array<Record<string, unknown>>) {
      expect(Object.keys(row).sort()).toEqual(['name', 'personId']);
    }
    const unchosen = await post(director, `/${second}/close`, { allowUnverified: true });
    expect([unchosen.status, unchosen.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);
    expect(unchosen.body.error.details).toEqual([{ field: 'signerHeadPersonId', message: expect.any(String) }]);
    const notHead = await post(director, `/${second}/close`, { allowUnverified: true, signerHeadPersonId: assistant.personId });
    expect([notHead.status, notHead.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);
    const both = await post(director, `/${second}/close`, {
      allowUnverified: true,
      signerHeadPersonId: headB.personId,
      attendedByPersonId: assistant.personId,
      attendedByName: 'Auxiliar de turno',
    });
    expect([both.status, both.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);
    expect(await scalar<string>(dataSource, 'SELECT status FROM physical_inventory WHERE id = $1', [second])).toBe('IN_PROGRESS');
    const chosen = await post(director, `/${second}/close`, {
      allowUnverified: true,
      signerHeadPersonId: headB.personId,
      attendedByName: 'Auxiliar de turno',
    });
    expect(chosen.status, JSON.stringify(chosen.body)).toBe(200);
    expect(chosen.body.data).toMatchObject({
      signerHead: { personId: headB.personId },
      attendedBy: { personId: null, name: 'Auxiliar de turno' },
      actIssuable: true,
      warnings: [],
    });
    await approve(second);
    expect(await payloadOf(second)).toMatchObject({ responsiblePersonId: headB.personId, fields: { atendioPorArea: 'Auxiliar de turno' } });

    // Ningún jefe: el cierre procede con el aviso; el acta queda NOT_ENQUEUED hasta asignar un jefe y reencolar.
    const headless = await center('Centro sin jefe');
    await newAsset(headless, 10);
    const third = await started(headless);
    const warned = await post(director, `/${third}/close`, { allowUnverified: true });
    expect(warned.status, JSON.stringify(warned.body)).toBe(200);
    expect(warned.body.data).toMatchObject({
      status: 'CLOSED',
      signerHead: null,
      actIssuable: false,
      warnings: [{ code: 'ACT_CANNOT_BE_ISSUED', message: expect.stringContaining('no tiene jefe vigente') }],
    });
    const reconciled = await approve(third);
    expect(reconciled.act).toMatchObject({ generation: 'NOT_ENQUEUED', reason: 'NO_COST_CENTER_HEAD', retryAction: 'ENQUEUE' });
    expect(reconciled.warnings).toEqual([{ code: 'ACT_CANNOT_BE_ISSUED', message: expect.any(String), costCenterId: headless }]);
    expect(await payloadOf(third)).toBeUndefined();
    const stillBlocked = await post(director, `/${third}/act/enqueue`);
    expect([stillBlocked.status, stillBlocked.body.error.code]).toEqual([406, 'INVALID_STATE']);
    expect(stillBlocked.body.error.details).toEqual([{ field: 'reason', message: 'NO_COST_CENTER_HEAD' }]);
    const newcomer = await person('Nueva jefa', null);
    const early = await put(director, `/${third}/signer-head`, { signerHeadPersonId: newcomer.personId });
    expect([early.status, early.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);
    await headOf(headless, newcomer);
    const assigned = await put(director, `/${third}/signer-head`, { signerHeadPersonId: newcomer.personId });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    expectConforms('put', '/api/v1/inventories/{id}/signer-head', 200, assigned.body);
    expect(assigned.body.data).toMatchObject({ signerHead: { personId: newcomer.personId }, actIssuable: true, warnings: [] });
    const enqueued = await post(director, `/${third}/act/enqueue`);
    expect(enqueued.status, JSON.stringify(enqueued.body)).toBe(200);
    expect(enqueued.body.data).toMatchObject({ generation: 'PENDING', reason: null });
    expect(await payloadOf(third)).toMatchObject({ responsiblePersonId: newcomer.personId, fields: { atendioPorArea: 'Sin dato' } });
    // Ya encolada: no se cambia el firmante.
    const late = await put(director, `/${third}/signer-head`, { signerHeadPersonId: newcomer.personId });
    expect(late.status).toBe(406);
  });

  it('toma por ubicación con activos de 3 centros: un acta por centro, con su consecutivo, sus hallazgos y su jefe; el centro sin jefe no bloquea las demás', async () => {
    const put = (path: string, body: Record<string, unknown>) =>
      http().put(`/api/v1/inventories${path}`).set(as(director)).send(body);
    const lab = await scalar<string>(
      dataSource,
      `INSERT INTO location (building_id, code, name, location_type)
       SELECT building_id, $1, 'Laboratorio compartido', 'OFFICE' FROM location WHERE id = $2 RETURNING id`,
      [`IT-LAB${randomUUID().slice(0, 4)}`, base.roomA],
    );
    const faculty = await center('Facultad');
    const systems = await center('Sistemas');
    const maintenance = await center('Mantenimiento');
    const code = (id: string) => scalar<string>(dataSource, 'SELECT external_code FROM cost_center WHERE id = $1', [id]);
    const deanHead = await headOf(faculty, await person('Decana', null));
    const systemsA = await headOf(systems, await person('Jefa Sistemas', null));
    const systemsB = await headOf(systems, await person('Jefe Sistemas', null));
    const inLab = async (costCenterId: string, price: number) => {
      const id = await newAsset(costCenterId, price);
      await dataSource.query('UPDATE asset SET current_location_id = $2 WHERE id = $1', [id, lab]);
      return id;
    };
    const microscope = await inLab(faculty, 1000);
    const lostScope = await inLab(faculty, 500);
    const server = await inLab(systems, 300);
    const drill = await inLab(maintenance, 200);

    const scheduled = await http()
      .post('/api/v1/inventories')
      .set(as(director))
      .send({
        name: 'Toma del laboratorio',
        scope: 'LOCATION',
        scopeId: lab,
        plannedStartDate: today,
        plannedEndDate: addDays(today, 2),
        responsibleUserId: director.userId,
        reminderOffsetsDays: [],
      });
    expect(scheduled.status, JSON.stringify(scheduled.body)).toBe(201);
    const id = scheduled.body.data.id as string;
    expect((await post(director, `/${id}/start`)).status).toBe(200);
    const view = await detail(id);
    expect(view.items).toHaveLength(4);
    for (const assetId of [microscope, server, drill]) {
      expect((await post(director, `/${id}/verify-asset`, { assetId, condition: 'GOOD' })).status).toBe(200);
    }
    expect((await post(director, `/${id}/report-not-found`, { assetId: lostScope, otherCause: 'Se desconoce' })).status).toBe(200);
    for (const [assetId, category] of [
      [microscope, 'AU'],
      [lostScope, 'ANE'],
      [server, 'AU'],
      [drill, 'AU'],
    ] as const) {
      const set = await http()
        .put(`/api/v1/inventories/${id}/items/${itemOf(view.items, assetId).id}/finding-category`)
        .set(as(director))
        .send({ code: category });
      expect(set.status, JSON.stringify(set.body)).toBe(200);
    }
    const chair = await post(director, `/${id}/report-unexpected`, { notes: 'Silla sin placa', locationId: lab });
    expect(chair.status).toBe(200);
    expect((await post(director, `/${id}/report-unexpected`, { notes: 'Caja sin placa', locationId: lab })).status).toBe(200);

    // Jefes candidatos por centro, antes del cierre.
    const candidates = await http().get(`/api/v1/inventories/${id}/acts/head-candidates`).set(as(director)).expect(200);
    expectConforms('get', '/api/v1/inventories/{id}/acts/head-candidates', 200, candidates.body);
    const byCenter = new Map(
      (candidates.body.data as Array<{ costCenter: { id: string }; candidates: Array<{ personId: string }> }>).map((row) => [
        row.costCenter.id,
        row.candidates.map((candidate) => candidate.personId).sort(),
      ]),
    );
    expect(byCenter).toEqual(
      new Map([
        [faculty, [deanHead.personId]],
        [systems, [systemsA.personId, systemsB.personId].sort()],
        [maintenance, []],
      ]),
    );
    expect((await http().get(`/api/v1/inventories/${id}/head-candidates`).set(as(director)).expect(200)).body.data).toEqual([]);

    // Sistemas tiene dos jefes: hay que elegir; signerHeadPersonId solo sirve con un único centro.
    const unchosen = await post(director, `/${id}/close`, { allowUnverified: true });
    expect([unchosen.status, unchosen.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);
    expect(unchosen.body.error.details).toEqual([{ field: `signerHeads.${systems}`, message: expect.any(String) }]);
    const legacy = await post(director, `/${id}/close`, { allowUnverified: true, signerHeadPersonId: systemsB.personId });
    expect([legacy.status, legacy.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);
    const wrongCenter = await post(director, `/${id}/close`, {
      allowUnverified: true,
      signerHeads: [{ costCenterId: systems, personId: deanHead.personId }],
    });
    expect([wrongCenter.status, wrongCenter.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);
    const closed = await post(director, `/${id}/close`, {
      allowUnverified: true,
      signerHeads: [{ costCenterId: systems, personId: systemsB.personId }],
      attendedByName: 'Auxiliar del laboratorio',
      attendedBy: [{ costCenterId: systems, name: 'Técnico de sistemas' }],
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expectConforms('post', '/api/v1/inventories/{id}/close', 200, closed.body);
    const acts = (body: { acts: Array<Record<string, unknown>> }) =>
      new Map(body.acts.map((act) => [(act['costCenter'] as { id: string }).id, act]));
    const atClose = acts(closed.body.data);
    expect(atClose.size).toBe(3);
    expect(closed.body.data).toMatchObject({
      act: null,
      signerHead: null,
      actIssuable: false,
      unassignedItems: 2,
      warnings: [{ code: 'ACT_CANNOT_BE_ISSUED', costCenterId: maintenance, message: expect.stringContaining('no tiene jefe vigente') }],
    });
    expect(atClose.get(faculty)).toMatchObject({
      costCenter: { id: faculty, code: await code(faculty), name: 'Facultad' },
      signerHead: { personId: deanHead.personId },
      attendedBy: { personId: null, name: 'Auxiliar del laboratorio' },
      issuable: true,
      warnings: [],
      generation: 'NONE',
    });
    expect(atClose.get(systems)).toMatchObject({
      signerHead: { personId: systemsB.personId },
      attendedBy: { personId: null, name: 'Técnico de sistemas' },
      issuable: true,
    });
    expect(atClose.get(maintenance)).toMatchObject({ signerHead: null, issuable: false, warnings: [{ costCenterId: maintenance }] });

    // El sobrante registrado como activo de la facultad va a su acta; el otro sigue sin acta.
    const resolved = await post(director, `/${id}/items/${chair.body.data.id as string}/resolve-surplus`, {
      action: 'CREATE_ASSET',
      reason: 'Se registra',
      costCenterId: faculty,
      asset: {
        description: 'Silla del laboratorio',
        categoryId: base.categoryId,
        acquisitionTypeId: base.acquisitionTypeId,
        acquisitionDate: '2024-02-10',
        acquisitionPrice: 50,
      },
    });
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect(((await detail(id)) as unknown as { unassignedItems: number }).unassignedItems).toBe(1);

    // La caja no es de ningún centro: no se concilia hasta elegir su centro (o registrarla como activo).
    const blockedReconcile = await post(director, `/${id}/reconcile`);
    expect([blockedReconcile.status, blockedReconcile.body.error.code]).toEqual([409, 'INVENTORY_UNASSIGNED_SURPLUS']);
    expect(blockedReconcile.body.error.details).toEqual([{ field: 'unassignedSurplus', message: '1' }]);
    expect(blockedReconcile.body.error.message).toContain('1 sobrante sin centro de costo');
    const boxId = ((await detail(id)).items as unknown as Array<{ id: string; notes: string | null }>)
      .find((item) => item.notes === 'Caja sin placa')?.id as string;
    // Dejarla sin resolver también pide el centro: sin él nadie respondería por ella.
    const leftWithoutCenter = await post(director, `/${id}/items/${boxId}/resolve-surplus`, { action: 'LEAVE_UNRESOLVED', reason: 'Sin datos' });
    expect([leftWithoutCenter.status, leftWithoutCenter.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);
    expect(leftWithoutCenter.body.error.details).toEqual([expect.objectContaining({ field: 'costCenterId' })]);
    const inactiveCenter = await center('Inactivo');
    await dataSource.query('UPDATE cost_center SET is_active = FALSE WHERE id = $1', [inactiveCenter]);
    const toInactive = await put(`/${id}/items/${boxId}/surplus-center`, { costCenterId: inactiveCenter });
    expect([toInactive.status, toInactive.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);
    const chairAgain = await put(`/${id}/items/${chair.body.data.id as string}/surplus-center`, { costCenterId: systems });
    expect([chairAgain.status, chairAgain.body.error.code]).toEqual([406, 'INVENTORY_SURPLUS_NOT_RESOLVABLE']);
    const boxToSystems = await put(`/${id}/items/${boxId}/surplus-center`, { costCenterId: systems });
    expect(boxToSystems.status, JSON.stringify(boxToSystems.body)).toBe(200);
    expectConforms('put', '/api/v1/inventories/{id}/items/{itemId}/surplus-center', 200, boxToSystems.body);
    expect(boxToSystems.body.data).toMatchObject({ id: boxId, surplusCostCenterId: systems, surplusResolution: null });
    expect(((await detail(id)) as unknown as { unassignedItems: number }).unassignedItems).toBe(0);
    const [centerAudit] = (await dataSource.query(
      `SELECT changes FROM audit_log WHERE entity_type = 'INVENTORY' AND entity_id = $1 AND action = 'INV_SURPLUS_CENTER'`,
      [id],
    )) as Array<{ changes: Record<string, unknown> }>;
    expect(centerAudit?.changes).toEqual({ itemId: boxId, surplusCostCenterId: { from: null, to: systems } });

    expect((await post(director, `/${id}/reconcile`)).status).toBe(200);
    const approved = await post(approver, `/${id}/reconcile/approve`);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expectConforms('post', '/api/v1/inventories/{id}/reconcile/approve', 200, approved.body);
    const afterApproval = acts(approved.body.data);
    expect(afterApproval.get(faculty)).toMatchObject({ generation: 'PENDING', reason: null });
    expect(afterApproval.get(systems)).toMatchObject({ generation: 'PENDING', reason: null });
    expect(afterApproval.get(maintenance)).toMatchObject({
      generation: 'NOT_ENQUEUED',
      reason: 'NO_COST_CENTER_HEAD',
      retryable: true,
      retryAction: 'ENQUEUE',
    });
    await engine.processPending(1000);

    const text = async (documentId: unknown) => {
      const [row] = (await dataSource.query(
        'SELECT docx_driver, docx_key, entity_type, entity_id FROM document WHERE id = $1',
        [documentId],
      )) as Array<{ docx_driver: StorageDriver; docx_key: string; entity_type: string; entity_id: string }>;
      expect(row?.entity_type).toBe('PHYSICAL_INVENTORY_ACT');
      return docxText(await app.get(StorageService).getFrom(row?.docx_driver ?? 'project', row?.docx_key ?? ''));
    };
    const generated = acts((await detail(id)) as never);
    const facultyAct = generated.get(faculty) as Record<string, unknown>;
    const systemsAct = generated.get(systems) as Record<string, unknown>;
    expect(facultyAct).toMatchObject({ generation: 'GENERATED', status: 'PENDING_SIGNATURE' });
    expect(systemsAct).toMatchObject({ generation: 'GENERATED', status: 'PENDING_SIGNATURE' });
    expect(facultyAct['number']).not.toEqual(systemsAct['number']);

    // El documento del acta dice cómo volver a la toma y a su centro.
    const facultyDocument = await http().get(`/api/v1/documents/${String(facultyAct['documentId'])}`).set(as(director));
    expect(facultyDocument.status, JSON.stringify(facultyDocument.body)).toBe(200);
    expectConforms('get', '/api/v1/documents/{id}', 200, facultyDocument.body);
    expect(facultyDocument.body.data).toMatchObject({
      entityType: 'PHYSICAL_INVENTORY_ACT',
      entityId: facultyAct['id'],
      links: { inventoryId: id, costCenterId: faculty },
    });

    const facultyText = await text(facultyAct['documentId']);
    expect(facultyText).toContain(`CENTRO|${await code(faculty)}|Auxiliar del laboratorio|${String(facultyAct['number'])}|`);
    expect(facultyText).toContain('|Ubicación ');
    // Solo los activos de la facultad: 2 esperados, 1 verificado, 1 faltante; el sobrante registrado como su activo.
    expect(facultyText).toContain('TOTALES|2|1|1|1|');
    // Porcentaje sobre el precio de compra de las categorías de la facultad (1000 y 500).
    expect(facultyText).toContain(`H|AU|1|${formatMoney(1000)}|66,67 %|`);
    expect(facultyText).toContain(`H|ANE|1|${formatMoney(500)}|33,33 %|`);
    expect(facultyText).toContain('S|Silla sin placa|Registrado como activo|');
    expect(facultyText).not.toContain('Caja sin placa');
    expect(facultyText).toContain('FIRMAS|Decana Valoración|Aprobador Valoración|');

    const systemsText = await text(systemsAct['documentId']);
    expect(systemsText).toContain(`CENTRO|${await code(systems)}|Técnico de sistemas|${String(systemsAct['number'])}|`);
    expect(systemsText).toContain('TOTALES|1|1|0|1|');
    expect(systemsText).toContain(`H|AU|1|${formatMoney(300)}|100,00 %|`);
    // La caja quedó en el acta de Sistemas, sin decisión; la silla, en la de la facultad.
    expect(systemsText).toContain('S|Caja sin placa|Sin decisión|');
    expect(systemsText).not.toContain('Silla sin placa');
    expect(systemsText).toContain('FIRMAS|Jefe Sistemas Valoración|Aprobador Valoración|');

    // Mantenimiento: sin jefe no se encola; se le asigna jefe, se indica y se encola sola.
    const maintenanceId = (generated.get(maintenance) as { id: string }).id;
    const blocked = await post(director, `/${id}/acts/${maintenance}/enqueue`);
    expect([blocked.status, blocked.body.error.code]).toEqual([406, 'INVALID_STATE']);
    expect(blocked.body.error.details).toEqual([{ field: 'reason', message: 'NO_COST_CENTER_HEAD' }]);
    // Con varias actas, las rutas de compatibilidad piden el centro.
    expect((await post(director, `/${id}/act/enqueue`)).status).toBe(406);
    const newcomer = await person('Jefe Mantenimiento', null);
    const early = await put(`/${id}/acts/${maintenance}/signer-head`, { signerHeadPersonId: newcomer.personId });
    expect([early.status, early.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);
    await headOf(maintenance, newcomer);
    expect((await put(`/${id}/signer-head`, { signerHeadPersonId: newcomer.personId })).status).toBe(406);
    const assigned = await put(`/${id}/acts/${maintenance}/signer-head`, { signerHeadPersonId: newcomer.personId });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    expectConforms('put', '/api/v1/inventories/{id}/acts/{costCenterId}/signer-head', 200, assigned.body);
    expect(assigned.body.data).toMatchObject({ actIssuable: true, warnings: [] });
    // Un acta ya encolada no cambia de firmante.
    expect((await put(`/${id}/acts/${systems}/signer-head`, { signerHeadPersonId: systemsA.personId })).status).toBe(406);
    const enqueued = await post(director, `/${id}/acts/${maintenance}/enqueue`);
    expect(enqueued.status, JSON.stringify(enqueued.body)).toBe(200);
    expectConforms('post', '/api/v1/inventories/{id}/acts/{costCenterId}/enqueue', 200, enqueued.body);
    expect(enqueued.body.data).toMatchObject({
      id: maintenanceId,
      costCenter: { id: maintenance },
      signerHead: { personId: newcomer.personId },
      generation: 'PENDING',
    });
    await engine.processPending(1000);
    const maintenanceAct = acts((await detail(id)) as never).get(maintenance) as Record<string, unknown>;
    expect(maintenanceAct).toMatchObject({ generation: 'GENERATED' });
    expect(new Set([facultyAct['number'], systemsAct['number'], maintenanceAct['number']]).size).toBe(3);
    const maintenanceText = await text(maintenanceAct['documentId']);
    expect(maintenanceText).toContain('TOTALES|1|1|0|0|');
    expect(maintenanceText).toContain(`H|AU|1|${formatMoney(200)}|100,00 %|`);
    expect(maintenanceText).toContain('FIRMAS|Jefe Mantenimiento Valoración|Aprobador Valoración|');
    expect(
      await scalar<number>(dataSource, 'SELECT count(*)::int FROM physical_inventory_act WHERE inventory_id = $1', [id]),
    ).toBe(3);
  });
});
