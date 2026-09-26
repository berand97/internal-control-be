// Importación asíncrona (outbox + worker): confirmar encola y responde, el worker procesa, progreso, fallo a mitad
// y reintento idempotente, dos workers, notificación en la app, correo por outbox y firma de los movimientos
// escritos por conjuntos. HTTP real + PostgreSQL real.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { createAppValidationPipe } from '../../src/common/pipes/app-validation.pipe.js';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';
import { MovementType } from '../../src/modules/assets/enums/movement-type.enum.js';
import { OperationalStatus } from '../../src/modules/assets/enums/operational-status.enum.js';
import { AssetsService } from '../../src/modules/assets/services/assets.service.js';
import { TokenService } from '../../src/modules/auth/services/token.service.js';
import { SIGNATURE_VERSION } from '../../src/modules/movements/crypto/sign-movement.js';
import { MovementsService } from '../../src/modules/movements/services/movements.service.js';
import { NotificationsService } from '../../src/modules/notifications/services/notifications.service.js';
import { ExcelImportService } from '../../src/modules/staging/services/excel-import.service.js';
import { ImportJobsService } from '../../src/modules/staging/services/import-jobs.service.js';
import { MailOutboxService } from '../../src/shared/mail/mail-outbox.service.js';
import { createActor, scalar } from './helpers.js';

type Cell = string | number | Date | null;

const workbook = async (sheet: string, rows: Cell[][]): Promise<Buffer> => {
  const book = new ExcelJS.Workbook();
  const ws = book.addWorksheet(sheet);
  rows.forEach((values, index) => {
    const row = ws.getRow(index + 1);
    values.forEach((value, column) => {
      if (value !== null) {
        row.getCell(column + 1).value = value;
      }
    });
    row.commit();
  });
  return Buffer.from(await book.xlsx.writeBuffer());
};

const ASSET_MAPPING = {
  legacyAssetId: 'A',
  legacyCode: 'B',
  description: 'C',
  costCenterCode: 'D',
  acquisitionDate: 'E',
  acquisitionPrice: 'F',
};

describe('Importación asíncrona: trabajos, worker, notificaciones y firma (HTTP real + PostgreSQL real)', () => {
  let app: NestExpressApplication;
  let dataSource: DataSource;
  let imports: ExcelImportService;
  let jobs: ImportJobsService;
  let movements: MovementsService;
  let notifications: NotificationsService;
  let outbox: MailOutboxService;
  let actor: AuthenticatedUser;
  let token = '';
  let center = '';

  const http = () => request(app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const count = (sql: string, params: unknown[] = []) => scalar<string>(dataSource, sql, params).then(Number);
  const tag = () => randomUUID().slice(0, 6).toUpperCase();

  /** Sube y previsualiza un archivo de activos con `n` filas válidas y 2 en cuarentena; devuelve importId e ids. */
  const assetPreview = async (n: number) => {
    const t = tag();
    const ids = Array.from({ length: n }, (_, index) => `AJ-${t}-${index + 1}`);
    const rows: Cell[][] = [
      ['Id', 'Codigo', 'Descripcion', 'Centro', 'Fecha compra', 'Precio'],
      ...ids.map((id, index): Cell[] => [
        id,
        `C-${t}-${index}`,
        `Activo ${index}`,
        center,
        index % 2 === 0 ? new Date('2020-03-01') : null,
        1000 + index,
      ]),
      [`AJ-${t}-X`, 'C-X', 'Centro inexistente', 'NO-EXISTE', new Date('2020-01-01'), 5],
      [null, null, null, center, null, 5],
    ];
    const upload = await imports.upload(await workbook('Activos', rows), `activos-${t}.xlsx`, actor.id);
    const preview = await imports.preview(upload.batchId, { sheet: 'Activos', target: 'ASSETS', mapping: ASSET_MAPPING }, actor.id);
    expect(preview.summary).toMatchObject({ toInsert: n, quarantined: { COST_CENTER_UNKNOWN: 1, ROW_WITHOUT_ASSET_ID: 1 } });
    return { importId: preview.importId, ids };
  };

  const importedAssets = (importId: string) =>
    dataSource.query('SELECT asset_id FROM asset_import_origin WHERE import_id = $1', [importId]) as Promise<
      Array<{ asset_id: string }>
    >;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
    // Los crons (worker de importaciones cada 5 s, documentos) se detienen: el test decide cuándo corre el worker.
    for (const job of app.get(SchedulerRegistry).getCronJobs().values()) {
      await job.stop();
    }
    dataSource = app.get(DataSource);
    imports = app.get(ExcelImportService);
    jobs = app.get(ImportJobsService);
    movements = app.get(MovementsService);
    notifications = app.get(NotificationsService);
    outbox = app.get(MailOutboxService);
    actor = await createActor(dataSource);
    await dataSource.query(
      `INSERT INTO user_role (user_id, role_id, scope_type, scope_id) SELECT $1, id, 'GLOBAL', NULL FROM role WHERE code = 'INTERNAL_CONTROL_DIRECTOR'`,
      [actor.id],
    );
    token = app.get(TokenService).signAccessToken({ ...actor, sessionId: randomUUID() });
    // Sin SMTP: los correos del outbox deben quedar FAILED y visibles.
    await dataSource.query('UPDATE mail_settings SET enabled = FALSE');

    // Centros de costo por el camino asíncrono (destino COST_CENTERS).
    center = `AJ-${tag()}`;
    const centers = await imports.upload(
      await workbook('Centros', [['Codigo', 'Nombre'], [center, 'Centro importación asíncrona'], [`${center}-B`, 'Otro']]),
      `centros-${center}.xlsx`,
      actor.id,
    );
    const preview = await imports.preview(centers.batchId, { sheet: 'Centros', target: 'COST_CENTERS', mapping: { code: 'A', name: 'B' } }, actor.id);
    const queued = await jobs.enqueue(preview.importId, actor.id);
    expect(queued).toMatchObject({ status: 'QUEUED', target: 'COST_CENTERS' });
    expect(await jobs.processJob(queued.id)).toBe('SUCCEEDED');
    expect((await jobs.find(queued.id)).result).toMatchObject({ inserted: 2, skippedAlreadyPresent: 0, registrationMovements: 0 });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  it('POST confirm responde 202 con el trabajo en cola sin escribir nada; el worker lo procesa después', async () => {
    const { importId } = await assetPreview(3);
    const assetsBefore = await count('SELECT count(*) FROM asset');
    const response = await http().post(`/api/v1/imports/previews/${importId}/confirm`).set(auth());
    expect(response.status).toBe(202);
    const job = response.body.data as { id: string; status: string; phase: string; progress: unknown; result: unknown };
    expect(job).toMatchObject({
      importId,
      target: 'ASSETS',
      status: 'QUEUED',
      phase: 'QUEUED',
      attempts: 0,
      progress: { movementsTotal: null, movementsDone: 0, percent: 0 },
      rows: null,
      result: null,
      error: null,
      email: null,
      requestedBy: actor.id,
    });
    // Nada se hizo en la petición.
    expect(await count('SELECT count(*) FROM asset')).toBe(assetsBefore);
    expect(await count('SELECT count(*) FROM staging_quarantine WHERE import_id = $1', [importId])).toBe(0);

    // Confirmar otra vez es idempotente: mismo trabajo.
    const again = await http().post(`/api/v1/imports/previews/${importId}/confirm`).set(auth());
    expect(again.status).toBe(202);
    expect(again.body.data.id).toBe(job.id);
    expect(await count('SELECT count(*) FROM staging_import_job WHERE import_id = $1', [importId])).toBe(1);

    expect(await jobs.processNext()).toBe('SUCCEEDED');
    const done = await http().get(`/api/v1/imports/jobs/${job.id}`).set(auth());
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({
      status: 'SUCCEEDED',
      phase: 'DONE',
      attempts: 1,
      progress: { movementsTotal: 3, movementsDone: 3, percent: 100 },
      rows: { inserted: 3, skippedAlreadyPresent: 0, quarantined: { COST_CENTER_UNKNOWN: 1, ROW_WITHOUT_ASSET_ID: 1 } },
      result: {
        inserted: 3,
        skippedAlreadyPresent: 0,
        quarantined: { COST_CENTER_UNKNOWN: 1, ROW_WITHOUT_ASSET_ID: 1 },
        costCentersCreated: 0,
        registrationMovements: 3,
      },
      error: null,
      email: { status: 'PENDING_SEND', attempts: 0, lastError: null, sentAt: null },
    });
    expect(await scalar<string>(dataSource, 'SELECT status FROM staging_import WHERE id = $1', [importId])).toBe('CONFIRMED');

    const byImport = await http().get(`/api/v1/imports/previews/${importId}/job`).set(auth());
    expect(byImport.body.data.id).toBe(job.id);
    const mine = await http().get('/api/v1/imports/jobs').set(auth());
    expect((mine.body.data as Array<{ id: string }>).map((item) => item.id)).toContain(job.id);

    // Sin SMTP el correo queda FALLIDO y visible en el trabajo.
    await outbox.dispatchPending();
    const mailed = await jobs.find(job.id);
    expect(mailed.email).toMatchObject({
      status: 'FAILED',
      attempts: 1,
      lastError: 'El correo saliente (SMTP) no está configurado o está deshabilitado',
    });
  });

  it('notificación en la app en la misma transacción que termina el trabajo, con conteos; campana por HTTP', async () => {
    const { importId } = await assetPreview(2);
    const job = await jobs.enqueue(importId, actor.id);
    await jobs.processJob(job.id);
    const [notification] = (await dataSource.query(
      `SELECT id, notification_type, title, body, entity_type, entity_id, read_at FROM notification
       WHERE recipient_user_id = $1 AND entity_id = $2`,
      [actor.id, job.id],
    )) as Array<Record<string, string | null>>;
    expect(notification).toMatchObject({
      notification_type: 'IMPORT_FINISHED',
      title: 'Importación de activos terminada',
      entity_type: 'STAGING_IMPORT_JOB',
      read_at: null,
    });
    expect(notification?.['body']).toContain('Insertados: 2');
    expect(notification?.['body']).toContain('Omitidos por ya existir: 0');
    expect(notification?.['body']).toContain('En cuarentena: 2');
    expect(notification?.['body']).toContain('1 · El centro de costo no existe en el catálogo [COST_CENTER_UNKNOWN]');
    const [mail] = (await dataSource.query(
      `SELECT template_type, recipient_user_id, context, delivery_status FROM mail_outbox WHERE entity_id = $1`,
      [job.id],
    )) as Array<{ template_type: string; recipient_user_id: string; context: Record<string, string>; delivery_status: string }>;
    expect(mail).toMatchObject({
      template_type: 'IMPORT_FINISHED',
      recipient_user_id: actor.id,
      delivery_status: 'PENDING_SEND',
      context: { 'importacion.estado': 'terminada', 'importacion.destino': 'activos' },
    });
    expect(mail?.context['importacion.resumen']).toContain('Insertados: 2');

    const unread = await http().get('/api/v1/notifications/unread-count').set(auth());
    expect(unread.status).toBe(200);
    const before = unread.body.data.count as number;
    expect(before).toBeGreaterThanOrEqual(1);
    const list = await http().get('/api/v1/notifications').query({ unread: 'true', pageSize: 50 }).set(auth());
    expect(list.body.data).toMatchObject({ unread: before, total: before, page: 1, pageSize: 50 });
    expect((list.body.data.items as Array<{ id: string }>).map((item) => item.id)).toContain(notification?.['id']);

    const read = await http().post(`/api/v1/notifications/${notification?.['id']}/read`).set(auth());
    expect(read.status).toBe(200);
    expect(read.body.data).toMatchObject({ id: notification?.['id'], type: 'IMPORT_FINISHED', entityId: job.id });
    expect(read.body.data.readAt).not.toBeNull();
    expect((await http().get('/api/v1/notifications/unread-count').set(auth())).body.data.count).toBe(before - 1);

    // Otro usuario no ve ni marca las ajenas.
    const other = await createActor(dataSource);
    const otherToken = app.get(TokenService).signAccessToken({ ...other, sessionId: randomUUID() });
    const foreign = await http()
      .post(`/api/v1/notifications/${notification?.['id']}/read`)
      .set({ Authorization: `Bearer ${otherToken}` });
    expect(foreign.status).toBe(404);
    expect((await notifications.list(other.id, { unreadOnly: false, page: 1, pageSize: 20 })).total).toBe(0);

    const all = await http().post('/api/v1/notifications/read-all').set(auth());
    expect(all.status).toBe(200);
    expect(all.body.data.updated).toBe(before - 1);
    expect(await notifications.unreadCount(actor.id)).toBe(0);
  });

  it('un fallo entre la inserción y los movimientos queda FAILED con su fase; reintentar no duplica y da conteos exactos', async () => {
    const { importId } = await assetPreview(4);
    const job = await jobs.enqueue(importId, actor.id);
    const spy = vi.spyOn(movements, 'recordInitial').mockRejectedValueOnce(new Error('Falla provocada por la prueba'));
    expect(await jobs.processJob(job.id)).toBe('FAILED');
    spy.mockRestore();

    const failed = await jobs.find(job.id);
    expect(failed).toMatchObject({
      status: 'FAILED',
      phase: 'MOVEMENTS',
      attempts: 1,
      error: 'Falla provocada por la prueba',
      progress: { movementsTotal: 4, movementsDone: 0, percent: 0 },
      rows: { inserted: 4, skippedAlreadyPresent: 0 },
      result: null,
    });
    // Las filas quedaron escritas (su transacción terminó); los movimientos no.
    const assets = await importedAssets(importId);
    expect(assets).toHaveLength(4);
    expect(await count('SELECT count(*) FROM asset_movement WHERE asset_id = ANY($1)', [assets.map((a) => a.asset_id)])).toBe(0);
    expect(await scalar<string>(dataSource, 'SELECT status FROM staging_import WHERE id = $1', [importId])).toBe('PREVIEWED');
    expect(
      await scalar<string>(
        dataSource,
        `SELECT notification_type FROM notification WHERE entity_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [job.id],
      ),
    ).toBe('IMPORT_FAILED');

    // Solo se reintenta lo FAILED.
    const retried = await http().post(`/api/v1/imports/jobs/${job.id}/retry`).set(auth());
    expect(retried.status).toBe(202);
    expect(retried.body.data).toMatchObject({ status: 'QUEUED', phase: 'QUEUED', error: null });
    const twice = await http().post(`/api/v1/imports/jobs/${job.id}/retry`).set(auth());
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('IMPORT_JOB_NOT_RETRYABLE');

    const assetsBefore = await count('SELECT count(*) FROM asset');
    expect(await jobs.processJob(job.id)).toBe('SUCCEEDED');
    const done = await jobs.find(job.id);
    expect(done).toMatchObject({
      status: 'SUCCEEDED',
      attempts: 2,
      progress: { movementsTotal: 4, movementsDone: 4, percent: 100 },
      // Conteos del intento que escribió las filas, no "0 insertados / 4 ya existían".
      result: { inserted: 4, skippedAlreadyPresent: 0, registrationMovements: 4, quarantined: { COST_CENTER_UNKNOWN: 1, ROW_WITHOUT_ASSET_ID: 1 } },
    });
    expect(await count('SELECT count(*) FROM asset')).toBe(assetsBefore);
    expect(await importedAssets(importId)).toHaveLength(4);
    const perAsset = (await dataSource.query(
      'SELECT asset_id, count(*)::int AS n FROM asset_movement WHERE asset_id = ANY($1) GROUP BY asset_id',
      [assets.map((a) => a.asset_id)],
    )) as Array<{ n: number }>;
    expect(perAsset).toHaveLength(4);
    expect(perAsset.every((row) => row.n === 1)).toBe(true);
    expect(await count('SELECT count(*) FROM staging_quarantine WHERE import_id = $1', [importId])).toBe(2);
  });

  it('un fallo dentro de la fase de filas no deja nada escrito y el reintento importa todo', async () => {
    const { importId } = await assetPreview(2);
    const job = await jobs.enqueue(importId, actor.id);
    const writeRows = imports.writeRows.bind(imports);
    // Escribe todo lo de la fase de filas y falla al final, dentro de la misma transacción.
    const rows = vi.spyOn(imports, 'writeRows').mockImplementationOnce(async (manager, id, actorId) => {
      await writeRows(manager, id, actorId);
      await manager.query(`INSERT INTO cost_center (external_code, name) VALUES ($1, 'Efímero')`, [`EF-${tag()}`]);
      throw new Error('Falla en filas provocada');
    });
    expect(await jobs.processJob(job.id)).toBe('FAILED');
    rows.mockRestore();
    expect(await jobs.find(job.id)).toMatchObject({ status: 'FAILED', phase: 'ROWS', rows: null, error: 'Falla en filas provocada' });
    expect(await importedAssets(importId)).toHaveLength(0);
    expect(await count(`SELECT count(*) FROM cost_center WHERE name = 'Efímero'`)).toBe(0);
    await jobs.retry(job.id);
    expect(await jobs.processJob(job.id)).toBe('SUCCEEDED');
    expect((await jobs.find(job.id)).result).toMatchObject({ inserted: 2, registrationMovements: 2 });
  });

  it('dos workers concurrentes no toman el mismo trabajo', async () => {
    const { importId } = await assetPreview(2);
    const job = await jobs.enqueue(importId, actor.id);
    const writeRows = imports.writeRows.bind(imports);
    let reached!: () => void;
    const inside = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = vi.spyOn(imports, 'writeRows').mockImplementationOnce(async (...args) => {
      reached();
      await gate;
      return writeRows(...args);
    });
    const first = jobs.processNext();
    await inside;
    // El primero tiene el trabajo (RUNNING y su fila bloqueada): el segundo no lo toma.
    expect(await jobs.processNext()).toBeNull();
    expect(await jobs.processJob(job.id)).toBeNull();
    release();
    expect(await first).toBe('SUCCEEDED');
    spy.mockRestore();
    expect(await jobs.find(job.id)).toMatchObject({ status: 'SUCCEEDED', attempts: 1, result: { inserted: 2, registrationMovements: 2 } });

    // Con dos trabajos en cola, dos workers a la vez toman uno cada uno.
    const a = await jobs.enqueue((await assetPreview(1)).importId, actor.id);
    const b = await jobs.enqueue((await assetPreview(1)).importId, actor.id);
    const outcomes = await Promise.all([jobs.processNext(), jobs.processNext()]);
    expect(outcomes.filter((outcome) => outcome === 'SUCCEEDED').length).toBeGreaterThanOrEqual(1);
    await jobs.processPending();
    for (const id of [a.id, b.id]) {
      expect(await jobs.find(id)).toMatchObject({ status: 'SUCCEEDED', attempts: 1, result: { inserted: 1, registrationMovements: 1 } });
    }
  });

  it('un trabajo RUNNING abandonado (sin latido) lo retoma otra instancia; el lease viejo ya no escribe', async () => {
    const { importId } = await assetPreview(2);
    const job = await jobs.enqueue(importId, actor.id);
    const staleLease = randomUUID();
    await dataSource.query(
      `UPDATE staging_import_job SET status = 'RUNNING', phase = 'ROWS', attempts = 1, lease_id = $2,
         heartbeat_at = NOW() - interval '11 minutes' WHERE id = $1`,
      [job.id, staleLease],
    );
    expect(await jobs.processNext()).toBe('SUCCEEDED');
    expect(await jobs.find(job.id)).toMatchObject({ status: 'SUCCEEDED', attempts: 2, result: { inserted: 2 } });
    expect(await count('SELECT count(*) FROM staging_import_job WHERE lease_id = $1', [staleLease])).toBe(0);
  });

  it('los movimientos escritos por conjuntos cumplen el esquema de firma y la verificación de cadenas', async () => {
    const { importId, ids } = await assetPreview(5);
    const job = await jobs.enqueue(importId, actor.id);
    await jobs.processJob(job.id);
    const rows = (await dataSource.query(
      `SELECT m.id, m.asset_id, m.movement_type, m.previous_movement_id, m.event_signature, m.metadata, m.executed_at,
              m.requested_by, m.authorized_by, m.reason, m.document_reference, m.to_cost_center_id,
              m.from_cost_center_id, m.to_operational_status, a.current_cost_center_id, o.row_number, o.legacy_asset_id
       FROM asset_movement m JOIN asset a ON a.id = m.asset_id JOIN asset_import_origin o ON o.asset_id = a.id
       WHERE o.import_id = $1 ORDER BY o.row_number`,
      [importId],
    )) as Array<Record<string, unknown> & { metadata: Record<string, unknown> }>;
    expect(rows).toHaveLength(5);
    for (const [index, row] of rows.entries()) {
      expect(row).toMatchObject({
        movement_type: 'REGISTRATION',
        previous_movement_id: null,
        requested_by: actor.id,
        authorized_by: actor.id,
        reason: 'Importación desde Excel',
        from_cost_center_id: null,
        to_cost_center_id: row['current_cost_center_id'],
        to_operational_status: 'IN_USE',
        legacy_asset_id: ids[index],
      });
      expect(row['document_reference']).toMatch(/^activos-.*\.xlsx#Activos!\d+$/);
      expect(row.metadata).toMatchObject({
        source: 'EXCEL_IMPORT',
        importId,
        row: row['row_number'],
        legacyAssetId: ids[index],
        executedAtKnown: index % 2 === 0,
        signatureVersion: SIGNATURE_VERSION,
      });
      if (index % 2 === 0) {
        expect((row['executed_at'] as Date).toISOString()).toBe('2020-03-01T00:00:00.000Z');
      }
      expect(await movements.verifyAssetChain(row['asset_id'] as string)).toEqual([]);
      expect(await movements.verify(row['id'] as string)).toEqual({ id: row['id'], valid: true, unsigned: false });
    }
    // La cadena sigue: un movimiento posterior por el camino normal se encadena al registro inicial y verifica.
    const first = rows[0]?.['asset_id'] as string;
    await app.get(AssetsService).changeStatus(first, OperationalStatus.InStorage, 'bodega', actor);
    const chain = (await dataSource.query(
      'SELECT id, previous_movement_id FROM asset_movement WHERE asset_id = $1 ORDER BY created_at',
      [first],
    )) as Array<{ id: string; previous_movement_id: string | null }>;
    expect(chain).toHaveLength(2);
    expect(chain[1]?.previous_movement_id).toBe(chain[0]?.id);
    expect(await movements.verifyAssetChain(first)).toEqual([]);
    // Alterar un registro inicial se detecta.
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    try {
      await runner.query('SET session_replication_role = replica');
      await runner.query(`UPDATE asset_movement SET reason = 'Otro' WHERE id = $1`, [rows[1]?.['id']]);
    } finally {
      await runner.query('SET session_replication_role = origin');
      await runner.release();
    }
    expect(await movements.verifyAssetChain(rows[1]?.['asset_id'] as string)).toEqual([
      { assetId: rows[1]?.['asset_id'], movementId: rows[1]?.['id'], reason: 'SIGNATURE_MISMATCH' },
    ]);
    // recordInitial se niega sobre un activo que ya tiene movimientos.
    await expect(
      dataSource.transaction((manager) =>
        movements.recordInitial(
          [
            {
              assetId: first,
              movementType: MovementType.Registration,
              fromCostCenterId: null,
              fromLocationId: null,
              fromResponsibleId: null,
              fromOperationalStatus: null,
              fromPhysicalCondition: null,
              toCostCenterId: null,
              toLocationId: null,
              toResponsibleId: null,
              toOperationalStatus: null,
              toPhysicalCondition: null,
              requestedBy: actor.id,
              authorizedBy: actor.id,
              reason: null,
              documentReference: null,
            },
          ],
          manager,
        ),
      ),
    ).rejects.toThrow('El registro inicial solo aplica a activos sin movimientos');
  });

  it('personas por el camino asíncrono: conteos exactos, aviso sin números de documento', async () => {
    const t = tag();
    const numbers = [`71${Date.now().toString().slice(-8)}`, `72${Date.now().toString().slice(-8)}`];
    const file = await workbook('Personas', [
      ['Documento', 'Nombre', 'Centro', 'Correo'],
      [numbers[0] ?? '', 'PERSONA UNO', center, `uno.${t}@unac.edu.co`.toLowerCase()],
      [numbers[1] ?? '', 'PERSONA DOS', center, null],
    ]);
    const upload = await imports.upload(file, `personas-${t}.xlsx`, actor.id);
    const preview = await imports.preview(
      upload.batchId,
      { sheet: 'Personas', target: 'PERSONS', mapping: { documentNumber: 'A', fullName: 'B', costCenterCode: 'C', email: 'D' } },
      actor.id,
    );
    const job = await jobs.enqueue(preview.importId, actor.id);
    expect(job).toMatchObject({ status: 'QUEUED', target: 'PERSONS' });
    expect(await count('SELECT count(*) FROM person WHERE document_number = ANY($1)', [numbers])).toBe(0);
    expect(await jobs.processJob(job.id)).toBe('SUCCEEDED');
    const done = await jobs.find(job.id);
    expect(done).toMatchObject({
      phase: 'DONE',
      progress: { movementsTotal: null, movementsDone: 0, percent: 100 },
      result: { inserted: 1, skippedAlreadyPresent: 0, quarantined: { EMAIL_MISSING: 1 }, registrationMovements: 0 },
    });
    const texts = (await dataSource.query(
      `SELECT body AS text FROM notification WHERE entity_id = $1
       UNION ALL SELECT context::text FROM mail_outbox WHERE entity_id = $1`,
      [job.id],
    )) as Array<{ text: string }>;
    expect(texts).toHaveLength(2);
    for (const { text } of texts) {
      for (const number of numbers) {
        expect(text).not.toContain(number);
      }
    }
    expect(texts[0]?.text).toContain('En cuarentena: 1');
  });
});
