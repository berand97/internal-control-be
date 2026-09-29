import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { createHash, randomUUID } from 'node:crypto';
import { get as httpGet, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { createAppValidationPipe } from '../../src/common/pipes/app-validation.pipe.js';
import { TokenService } from '../../src/modules/auth/services/token.service.js';
import { EventStreamsService } from '../../src/modules/events/services/event-streams.service.js';
import { NotificationsService } from '../../src/modules/notifications/services/notifications.service.js';
import { EventsMetrics } from '../../src/shared/events/events-metrics.js';
import { PgEventBus } from '../../src/shared/events/pg-event-bus.js';
import { openTestSession, scalar } from './helpers.js';

/**
 * Canal de eventos (SSE) con HTTP real y PostgreSQL real: ticket de un solo uso, entrega tras COMMIT vía
 * LISTEN/NOTIFY (también entre dos aplicaciones), Last-Event-ID, revocación de sesión en el latido, límites y
 * throttler. Latido corto por entorno (EVENTS_HEARTBEAT_MS) y límites chicos para poder probarlos.
 */
process.env['EVENTS_HEARTBEAT_MS'] = '300';
process.env['EVENTS_MAX_STREAMS'] = '4';
process.env['THROTTLE_USER_LIMIT'] = '20';

interface SseMessage {
  readonly event: string;
  readonly id: string | undefined;
  readonly data: Record<string, unknown>;
}

interface SseClient {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly messages: SseMessage[];
  /** Cuerpo JSON si la respuesta no fue un stream (errores). */
  readonly body: () => string;
  /** Latidos: eventos `ping` con data {} y sin id (no entran en messages). */
  pings: () => number;
  /** Comentarios SSE recibidos (el latido ya no es un comentario: EventSource no los entrega a JavaScript). */
  comments: () => number;
  isEnded: () => boolean;
  waitFor: (predicate: (message: SseMessage) => boolean, timeoutMs?: number) => Promise<SseMessage>;
  waitEnded: (timeoutMs?: number) => Promise<void>;
  close: () => void;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const openSse = (port: number, path: string, headers: Record<string, string> = {}): Promise<SseClient> =>
  new Promise((resolve, reject) => {
    const req = httpGet({ host: '127.0.0.1', port, path, headers: { Accept: 'text/event-stream', ...headers } }, (res) => {
      const messages: SseMessage[] = [];
      let raw = '';
      let buffer = '';
      let pings = 0;
      let comments = 0;
      let ended = false;
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        raw += chunk;
        buffer += chunk;
        let separator = buffer.indexOf('\n\n');
        while (separator >= 0) {
          const block = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          separator = buffer.indexOf('\n\n');
          let event = 'message';
          let id: string | undefined;
          let data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) {
              comments += 1;
            } else if (line.startsWith('event: ')) {
              event = line.slice(7);
            } else if (line.startsWith('id: ')) {
              id = line.slice(4);
            } else if (line.startsWith('data: ')) {
              data += line.slice(6);
            }
          }
          if (event === 'ping') {
            // Latido visible para EventSource: data {} y nunca id (no mueve Last-Event-ID).
            if (id !== undefined || data !== '{}') {
              throw new Error(`Latido inesperado: id=${id} data=${data}`);
            }
            pings += 1;
          } else if (data) {
            messages.push({ event, id, data: JSON.parse(data) as Record<string, unknown> });
          }
        }
      });
      const markEnded = (): void => {
        ended = true;
      };
      res.on('end', markEnded);
      res.on('close', markEnded);
      const waitUntil = async (check: () => boolean, timeoutMs: number, what: string): Promise<void> => {
        const deadline = Date.now() + timeoutMs;
        while (!check()) {
          if (Date.now() > deadline) {
            throw new Error(`Tiempo agotado esperando ${what}; recibido: ${JSON.stringify(messages.map((m) => m.event))}`);
          }
          await sleep(20);
        }
      };
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        messages,
        body: () => raw,
        pings: () => pings,
        comments: () => comments,
        isEnded: () => ended,
        waitFor: async (predicate, timeoutMs = 3000) => {
          await waitUntil(() => messages.some(predicate), timeoutMs, 'un evento');
          return messages.find(predicate) as SseMessage;
        },
        waitEnded: (timeoutMs = 3000) => waitUntil(() => ended, timeoutMs, 'el cierre'),
        close: () => req.destroy(),
      });
    });
    req.on('error', reject);
  });

const bootApp = async (): Promise<{ app: NestExpressApplication; port: number }> => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(createAppValidationPipe());
  await app.listen(0, '127.0.0.1');
  return { app, port: (app.getHttpServer().address() as AddressInfo).port };
};

describe('Canal de eventos SSE (HTTP real + PostgreSQL LISTEN/NOTIFY)', () => {
  let appA: NestExpressApplication;
  let appB: NestExpressApplication;
  let portA = 0;
  let portB = 0;
  let appBOpen = false;
  let dataSource: DataSource;
  const open: SseClient[] = [];
  const issuedTickets: string[] = [];
  const logged: string[] = [];

  interface TestUser {
    readonly id: string;
    readonly sessionId: string;
    readonly token: string;
  }

  const createUser = async (): Promise<TestUser> => {
    const tag = randomUUID().slice(0, 8);
    const personId = await scalar<string>(
      dataSource,
      `INSERT INTO person (first_name, last_name, email) VALUES ('Eventos', $1, $2) RETURNING id`,
      [tag, `eventos.${tag}@unac.edu.co`],
    );
    const id = await scalar<string>(
      dataSource,
      `INSERT INTO app_user (person_id, username, password_hash, status) VALUES ($1, $2, 'x', 'ACTIVE') RETURNING id`,
      [personId, `eventos.${tag}`],
    );
    const sessionId = await openTestSession(dataSource, id);
    const token = appA.get(TokenService).signAccessToken({
      id,
      personId,
      username: `eventos.${tag}`,
      roles: [],
      scopes: [],
      mustChangePassword: false,
      sessionId,
    });
    return { id, sessionId, token };
  };

  const ticketFor = async (user: TestUser, app: NestExpressApplication = appA): Promise<string> => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/events/ticket')
      .set('Authorization', `Bearer ${user.token}`);
    expect(response.status).toBe(200);
    const ticket = (response.body as { data: { ticket: string } }).data.ticket;
    issuedTickets.push(ticket);
    return ticket;
  };

  const connect = async (
    user: TestUser,
    options: { port?: number; app?: NestExpressApplication; lastEventId?: string; queryLastEventId?: string } = {},
  ): Promise<SseClient> => {
    const ticket = await ticketFor(user, options.app ?? appA);
    const query = options.queryLastEventId ? `&lastEventId=${options.queryLastEventId}` : '';
    const client = await openSse(
      options.port ?? portA,
      `/api/v1/events?ticket=${ticket}${query}`,
      options.lastEventId ? { 'Last-Event-ID': options.lastEventId } : {},
    );
    open.push(client);
    return client;
  };

  const notify = async (userId: string, title = 'Aviso de prueba', notifications = appA.get(NotificationsService)) =>
    dataSource.transaction((manager) =>
      notifications.create(manager, {
        recipientUserId: userId,
        type: 'IMPORT_FINISHED',
        title,
        body: 'cuerpo que no debe viajar por el stream',
        entityType: 'STAGING_IMPORT_JOB',
        entityId: randomUUID(),
      }),
    );

  const closeAll = async (): Promise<void> => {
    for (const client of open.splice(0)) {
      client.close();
    }
    const registries = [appA.get(EventStreamsService), ...(appBOpen ? [appB.get(EventStreamsService)] : [])];
    const deadline = Date.now() + 3000;
    while (registries.some((streams) => streams.openTotal() > 0) && Date.now() < deadline) {
      await sleep(20);
    }
  };

  beforeAll(async () => {
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation(function (this: Logger, message: unknown) {
        logged.push(String(message));
      });
    }
    ({ app: appA, port: portA } = await bootApp());
    ({ app: appB, port: portB } = await bootApp());
    appBOpen = true;
    dataSource = appA.get(DataSource);
  });

  afterEach(async () => {
    await closeAll();
  });

  afterAll(async () => {
    await closeAll();
    await appA?.close();
    if (appBOpen) {
      await appB.close();
    }
    vi.restoreAllMocks();
  });

  describe('ticket', () => {
    it('sin sesión no hay ticket', async () => {
      const response = await request(appA.getHttpServer()).post('/api/v1/events/ticket');
      expect(response.status).toBe(401);
    });

    it('opaco, vence en <= 30 s y en la BD solo queda su hash', async () => {
      const user = await createUser();
      const response = await request(appA.getHttpServer())
        .post('/api/v1/events/ticket')
        .set('Authorization', `Bearer ${user.token}`);
      expect(response.status).toBe(200);
      const { ticket, expiresAt } = (response.body as { data: { ticket: string; expiresAt: string } }).data;
      issuedTickets.push(ticket);
      expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const ttl = new Date(expiresAt).getTime() - Date.now();
      expect(ttl).toBeGreaterThan(20_000);
      expect(ttl).toBeLessThanOrEqual(31_000);
      const stored = (await dataSource.query(
        `SELECT encode(token_hash, 'hex') AS hash, session_id AS "sessionId" FROM event_stream_ticket WHERE user_id = $1`,
        [user.id],
      )) as Array<{ hash: string; sessionId: string }>;
      expect(stored).toEqual([{ hash: createHash('sha256').update(ticket).digest('hex'), sessionId: user.sessionId }]);
    });

    it('sirve una sola vez', async () => {
      const user = await createUser();
      const ticket = await ticketFor(user);
      const first = await openSse(portA, `/api/v1/events?ticket=${ticket}`);
      open.push(first);
      expect(first.status).toBe(200);
      await first.waitFor((m) => m.event === 'ready');
      const second = await openSse(portA, `/api/v1/events?ticket=${ticket}`);
      await second.waitEnded();
      expect(second.status).toBe(401);
      expect(JSON.parse(second.body())).toMatchObject({ error: { code: 'EVENTS_TICKET_INVALID' }, action: 'RETRY' });
      // Tampoco en la otra instancia: el ticket vive en la BD, no en memoria.
      const third = await openSse(portB, `/api/v1/events?ticket=${ticket}`);
      await third.waitEnded();
      expect(third.status).toBe(401);
    });

    it('vencido o inventado: 401 EVENTS_TICKET_INVALID', async () => {
      const user = await createUser();
      const ticket = await ticketFor(user);
      await dataSource.query(`UPDATE event_stream_ticket SET expires_at = NOW() - interval '1 second' WHERE user_id = $1`, [
        user.id,
      ]);
      const expired = await openSse(portA, `/api/v1/events?ticket=${ticket}`);
      await expired.waitEnded();
      expect(expired.status).toBe(401);
      expect(JSON.parse(expired.body())).toMatchObject({ error: { code: 'EVENTS_TICKET_INVALID' } });
      expect(await scalar<number>(dataSource, 'SELECT count(*)::int FROM event_stream_ticket WHERE user_id = $1', [user.id])).toBe(0);
      const invented = await openSse(portA, `/api/v1/events?ticket=${'A'.repeat(43)}`);
      await invented.waitEnded();
      expect(invented.status).toBe(401);
      const missing = await openSse(portA, '/api/v1/events');
      await missing.waitEnded();
      expect(missing.status).toBe(400);
    });

    it('queda ligado a la sesión: con la sesión cerrada ya no abre (SESSION_REVOKED)', async () => {
      const user = await createUser();
      const ticket = await ticketFor(user);
      const logout = await request(appA.getHttpServer()).post('/api/v1/auth/logout').set('Authorization', `Bearer ${user.token}`);
      expect(logout.status).toBe(200);
      const stream = await openSse(portA, `/api/v1/events?ticket=${ticket}`);
      await stream.waitEnded();
      expect(stream.status).toBe(401);
      expect(JSON.parse(stream.body())).toMatchObject({ error: { code: 'SESSION_REVOKED' } });
    });
  });

  describe('stream', () => {
    it('cabeceras para proxies y evento ready con el conteo; latido como evento `ping` (data {}, sin id), no comentario', async () => {
      const user = await createUser();
      await notify(user.id);
      await notify(user.id);
      const stream = await connect(user);
      expect(stream.status).toBe(200);
      expect(stream.headers['content-type']).toMatch(/^text\/event-stream/);
      expect(stream.headers['cache-control']).toContain('no-cache');
      expect(stream.headers['x-accel-buffering']).toBe('no');
      expect(stream.headers['connection']).toBe('keep-alive');
      expect(stream.headers['content-encoding']).toBeUndefined();
      const ready = await stream.waitFor((m) => m.event === 'ready');
      expect(ready.data).toEqual({ unread: 2, replayTruncated: false, heartbeatMs: 300 });
      const latest = await scalar<string>(dataSource, 'SELECT max(event_seq)::text FROM notification WHERE recipient_user_id = $1', [
        user.id,
      ]);
      expect(ready.id).toBe(latest);
      // Sin Last-Event-ID no repone nada: la lista se lee por GET /notifications.
      await sleep(700);
      expect(stream.messages.filter((m) => m.event === 'notification')).toHaveLength(0);
      expect(stream.pings()).toBeGreaterThanOrEqual(1);
      expect(stream.comments()).toBe(0);
      expect(stream.body()).toContain('event: ping\ndata: {}\n\n');
    });

    it('el evento sale DESPUÉS del COMMIT, con lo mismo que la lista (sin cuerpo), y no sale con ROLLBACK', async () => {
      const user = await createUser();
      const stream = await connect(user);
      await stream.waitFor((m) => m.event === 'ready');
      const notifications = appA.get(NotificationsService);

      const runner = dataSource.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      const id = await notifications.create(runner.manager, {
        recipientUserId: user.id,
        type: 'IMPORT_FAILED',
        title: 'Importación fallida',
        body: 'detalle privado',
        entityType: 'STAGING_IMPORT_JOB',
        entityId: randomUUID(),
      });
      await sleep(600);
      expect(stream.messages.filter((m) => m.event === 'notification')).toHaveLength(0);
      await runner.commitTransaction();
      await runner.release();
      const delivered = await stream.waitFor((m) => m.event === 'notification');
      const row = (await dataSource.query(
        `SELECT event_seq::text AS seq, entity_id AS "entityId", created_at AS "createdAt" FROM notification WHERE id = $1`,
        [id],
      )) as Array<{ seq: string; entityId: string; createdAt: Date }>;
      expect(delivered.id).toBe(row[0]?.seq);
      expect(delivered.data).toEqual({
        id,
        type: 'IMPORT_FAILED',
        title: 'Importación fallida',
        entityType: 'STAGING_IMPORT_JOB',
        entityId: row[0]?.entityId,
        createdAt: new Date(row[0]?.createdAt ?? 0).toISOString(),
      });
      const count = await stream.waitFor((m) => m.event === 'notification.count');
      expect(count.data).toEqual({ unread: 1 });

      const rollback = dataSource.createQueryRunner();
      await rollback.connect();
      await rollback.startTransaction();
      const ghost = await notifications.create(rollback.manager, {
        recipientUserId: user.id,
        type: 'IMPORT_FINISHED',
        title: 'Nunca existió',
        body: null,
        entityType: null,
        entityId: null,
      });
      await rollback.rollbackTransaction();
      await rollback.release();
      await sleep(800);
      expect(stream.messages.some((m) => m.event === 'notification' && m.data['id'] === ghost)).toBe(false);
      expect(stream.messages.filter((m) => m.event === 'notification')).toHaveLength(1);
    });

    it('marcar leída o todas publica notification.count; cada usuario recibe solo lo suyo', async () => {
      const user = await createUser();
      const other = await createUser();
      const stream = await connect(user);
      const otherStream = await connect(other);
      await stream.waitFor((m) => m.event === 'ready');
      await otherStream.waitFor((m) => m.event === 'ready');
      const first = await notify(user.id);
      await notify(user.id);
      await notify(other.id, 'Del otro');
      await stream.waitFor((m) => m.event === 'notification.count' && m.data['unread'] === 2);

      const read = await request(appA.getHttpServer())
        .post(`/api/v1/notifications/${first}/read`)
        .set('Authorization', `Bearer ${user.token}`);
      expect(read.status).toBe(200);
      await stream.waitFor((m) => m.event === 'notification.count' && m.data['unread'] === 1);
      const all = await request(appA.getHttpServer())
        .post('/api/v1/notifications/read-all')
        .set('Authorization', `Bearer ${user.token}`);
      expect(all.status).toBe(200);
      await stream.waitFor((m) => m.event === 'notification.count' && m.data['unread'] === 0);

      await otherStream.waitFor((m) => m.event === 'notification');
      expect(stream.messages.some((m) => m.data['title'] === 'Del otro')).toBe(false);
      expect(otherStream.messages.filter((m) => m.event === 'notification')).toHaveLength(1);
    });

    it('Last-Event-ID (cabecera o query) repone las posteriores en orden antes de seguir en vivo', async () => {
      const user = await createUser();
      await notify(user.id, 'antes');
      const first = await connect(user);
      const ready = await first.waitFor((m) => m.event === 'ready');
      first.close();
      const missed = [await notify(user.id, 'perdida 1'), await notify(user.id, 'perdida 2'), await notify(user.id, 'perdida 3')];

      const resumed = await connect(user, { lastEventId: ready.id as string });
      const resumedReady = await resumed.waitFor((m) => m.event === 'ready');
      expect(resumedReady.id).toBe(ready.id);
      expect(resumedReady.data).toMatchObject({ unread: 4, replayTruncated: false });
      await resumed.waitFor((m) => m.event === 'notification' && m.data['id'] === missed[2]);
      const replayed = resumed.messages.filter((m) => m.event === 'notification');
      expect(replayed.map((m) => m.data['id'])).toEqual(missed);
      const ids = replayed.map((m) => BigInt(m.id as string));
      expect(ids.every((id, index) => index === 0 || id > (ids[index - 1] as bigint))).toBe(true);
      expect(ids[0]).toBeGreaterThan(BigInt(ready.id as string));
      // Sigue en vivo después de reponer.
      const live = await notify(user.id, 'en vivo');
      await resumed.waitFor((m) => m.event === 'notification' && m.data['id'] === live);

      // Reconexión con ticket nuevo: lastEventId en la query.
      const viaQuery = await connect(user, { queryLastEventId: replayed[0]?.id as string });
      await viaQuery.waitFor((m) => m.event === 'notification' && m.data['id'] === live);
      expect(viaQuery.messages.filter((m) => m.event === 'notification').map((m) => m.data['id'])).toEqual([
        missed[1],
        missed[2],
        live,
      ]);
      expect(appA.get(EventsMetrics).snapshot().reconnects).toBeGreaterThanOrEqual(2);
    });

    it('con más de 100 pendientes repone las 100 más recientes y avisa replayTruncated', async () => {
      const user = await createUser();
      const first = await connect(user);
      const ready = await first.waitFor((m) => m.event === 'ready');
      first.close();
      await dataSource.query(
        `INSERT INTO notification (recipient_user_id, notification_type, title)
         SELECT $1, 'IMPORT_FINISHED', 'masiva ' || g FROM generate_series(1, 105) g`,
        [user.id],
      );
      const resumed = await connect(user, { lastEventId: ready.id as string });
      const resumedReady = await resumed.waitFor((m) => m.event === 'ready');
      expect(resumedReady.data).toMatchObject({ unread: 105, replayTruncated: true });
      await resumed.waitFor((m) => m.event === 'notification' && m.data['title'] === 'masiva 105');
      const replayed = resumed.messages.filter((m) => m.event === 'notification');
      expect(replayed).toHaveLength(100);
      expect(replayed[0]?.data['title']).toBe('masiva 6');
      const latest = await scalar<string>(dataSource, 'SELECT max(event_seq)::text FROM notification WHERE recipient_user_id = $1', [
        user.id,
      ]);
      expect(replayed.at(-1)?.id).toBe(latest);
    });

    it('sesión revocada: en el latido llega session.ended y se cierra el stream', async () => {
      const user = await createUser();
      const stream = await connect(user);
      await stream.waitFor((m) => m.event === 'ready');
      const logout = await request(appA.getHttpServer()).post('/api/v1/auth/logout').set('Authorization', `Bearer ${user.token}`);
      expect(logout.status).toBe(200);
      const ended = await stream.waitFor((m) => m.event === 'session.ended', 2000);
      expect(ended.data).toEqual({ reason: 'SESSION_REVOKED' });
      await stream.waitEnded();
      expect(appA.get(EventStreamsService).openFor(user.id)).toBe(0);
    });

    it('sesión revocada en OTRA instancia: el stream se cierra al vencer la caché de sesión (<= 5 s + latido)', async () => {
      const user = await createUser();
      const stream = await connect(user, { port: portB, app: appB });
      await stream.waitFor((m) => m.event === 'ready');
      await request(appA.getHttpServer()).post('/api/v1/auth/logout').set('Authorization', `Bearer ${user.token}`);
      await stream.waitFor((m) => m.event === 'session.ended', 7000);
      await stream.waitEnded();
    }, 15_000);
  });

  describe('límites', () => {
    it('máximo 3 por usuario: el 4.º cierra el más viejo con stream.closed REPLACED', async () => {
      const user = await createUser();
      const streams: SseClient[] = [];
      for (let index = 0; index < 3; index += 1) {
        const stream = await connect(user);
        await stream.waitFor((m) => m.event === 'ready');
        streams.push(stream);
      }
      const fourth = await connect(user);
      expect(fourth.status).toBe(200);
      await fourth.waitFor((m) => m.event === 'ready');
      const replaced = await streams[0]?.waitFor((m) => m.event === 'stream.closed');
      expect(replaced?.data).toEqual({ reason: 'REPLACED' });
      await streams[0]?.waitEnded();
      expect(streams[1]?.isEnded()).toBe(false);
      expect(streams[2]?.isEnded()).toBe(false);
      expect(appA.get(EventStreamsService).openFor(user.id)).toBe(3);
    });

    it('máximo por instancia (EVENTS_MAX_STREAMS=4): el siguiente recibe 503 EVENTS_CAPACITY_REACHED', async () => {
      const heavy = await createUser();
      const light = await createUser();
      for (let index = 0; index < 3; index += 1) {
        await (await connect(heavy)).waitFor((m) => m.event === 'ready');
      }
      await (await connect(light)).waitFor((m) => m.event === 'ready');
      expect(appA.get(EventStreamsService).openTotal()).toBe(4);
      const rejected = await connect(light);
      await rejected.waitEnded();
      expect(rejected.status).toBe(503);
      expect(JSON.parse(rejected.body())).toMatchObject({ error: { code: 'EVENTS_CAPACITY_REACHED' }, action: 'RETRY' });
      // Reemplazar uno propio no suma: se admite aunque la instancia esté llena.
      const replacing = await connect(heavy);
      expect(replacing.status).toBe(200);
      expect(appA.get(EventStreamsService).openTotal()).toBe(4);
      // La otra instancia tiene su propio cupo.
      const elsewhere = await connect(light, { port: portB, app: appB });
      expect(elsewhere.status).toBe(200);
    });

    it('el stream no pasa por el throttler; el ticket sí, por usuario', async () => {
      const user = await createUser();
      const stream = await connect(user);
      await stream.waitFor((m) => m.event === 'ready');
      // 19 tickets más (20 con el del stream): el 21.º excede THROTTLE_USER_LIMIT=20.
      for (let index = 0; index < 19; index += 1) {
        await ticketFor(user);
      }
      const blocked = await request(appA.getHttpServer())
        .post('/api/v1/events/ticket')
        .set('Authorization', `Bearer ${user.token}`);
      expect(blocked.status).toBe(429);
      // Otro usuario desde la misma IP conserva su cupo.
      await ticketFor(await createUser());
      // GET /events no cuenta: más aperturas que el límite por IP (100) y ninguna es 429.
      const statuses = new Set<number>();
      for (let index = 0; index < 110; index += 1) {
        const response = await request(appA.getHttpServer()).get(`/api/v1/events?ticket=${'B'.repeat(43)}`);
        statuses.add(response.status);
      }
      expect([...statuses]).toEqual([401]);
      // Y el stream abierto sigue vivo, con latidos.
      const before = stream.pings();
      await sleep(700);
      expect(stream.isEnded()).toBe(false);
      expect(stream.pings()).toBeGreaterThan(before);
    });
  });

  describe('LISTEN/NOTIFY entre instancias', () => {
    it('dos aplicaciones comparten eventos: la notificación creada en A llega al stream abierto en B', async () => {
      const user = await createUser();
      const onB = await connect(user, { port: portB, app: appB });
      const onA = await connect(user);
      await onB.waitFor((m) => m.event === 'ready');
      await onA.waitFor((m) => m.event === 'ready');
      const id = await notify(user.id, 'desde A', appA.get(NotificationsService));
      await onB.waitFor((m) => m.event === 'notification' && m.data['id'] === id);
      await onA.waitFor((m) => m.event === 'notification' && m.data['id'] === id);
      const fromB = await notify(user.id, 'desde B', appB.get(NotificationsService));
      await onA.waitFor((m) => m.event === 'notification' && m.data['id'] === fromB);
    });

    it('si se cae la conexión LISTEN se reabre y repone lo publicado mientras tanto', async () => {
      const user = await createUser();
      const stream = await connect(user);
      await stream.waitFor((m) => m.event === 'ready');
      const bus = appA.get(PgEventBus);
      const reconnectsBefore = appA.get(EventsMetrics).snapshot().busReconnects;
      await dataSource.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE application_name = 'control-interno-events' AND datname = current_database()`,
      );
      const deadline = Date.now() + 2000;
      while (bus.isListening() && Date.now() < deadline) {
        await sleep(10);
      }
      // Publicada mientras nadie escucha (A y B cayeron a la vez).
      const missed = await notify(user.id, 'durante la caída');
      await stream.waitFor((m) => m.event === 'notification' && m.data['id'] === missed, 5000);
      expect(bus.isListening()).toBe(true);
      expect(appA.get(EventsMetrics).snapshot().busReconnects).toBeGreaterThan(reconnectsBefore);
    });
  });

  describe('cierre y observabilidad', () => {
    it('al cerrar streams no quedan suscriptores; las métricas cuentan y los logs no llevan tickets', async () => {
      const user = await createUser();
      const stream = await connect(user);
      await stream.waitFor((m) => m.event === 'ready');
      expect(appA.get(PgEventBus).subscriberCount()).toBeGreaterThan(0);
      await closeAll();
      expect(appA.get(PgEventBus).subscriberCount()).toBe(0);
      const metrics = appA.get(EventsMetrics).snapshot();
      expect(metrics.openStreams).toBe(0);
      expect(metrics.streamsOpened).toBeGreaterThan(0);
      expect(metrics.eventsDelivered['ready']).toBeGreaterThan(0);
      expect(metrics.eventsDelivered['notification']).toBeGreaterThan(0);
      expect(metrics.streamsRejected.ticket).toBeGreaterThan(0);
      const text = logged.join('\n');
      for (const ticket of issuedTickets) {
        expect(text).not.toContain(ticket);
      }
      expect(text).not.toContain('cuerpo que no debe viajar');
    });

    it('al apagar la instancia: stream.closed SHUTDOWN, cierre y UNLISTEN', async () => {
      const user = await createUser();
      const stream = await connect(user, { port: portB, app: appB });
      await stream.waitFor((m) => m.event === 'ready');
      const listenersBefore = await scalar<number>(
        dataSource,
        `SELECT count(*)::int FROM pg_stat_activity WHERE application_name = 'control-interno-events' AND datname = current_database()`,
      );
      appBOpen = false;
      await appB.close();
      const closed = await stream.waitFor((m) => m.event === 'stream.closed');
      expect(closed.data).toEqual({ reason: 'SHUTDOWN' });
      await stream.waitEnded();
      expect(appB.get(PgEventBus).subscriberCount()).toBe(0);
      expect(appB.get(PgEventBus).isListening()).toBe(false);
      const deadline = Date.now() + 3000;
      let listenersAfter = listenersBefore;
      while (listenersAfter >= listenersBefore && Date.now() < deadline) {
        await sleep(50);
        listenersAfter = await scalar<number>(
          dataSource,
          `SELECT count(*)::int FROM pg_stat_activity WHERE application_name = 'control-interno-events' AND datname = current_database()`,
        );
      }
      expect(listenersAfter).toBe(listenersBefore - 1);
    });
  });
});
