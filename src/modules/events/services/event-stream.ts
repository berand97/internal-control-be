import type { Logger } from '@nestjs/common';
import type { Response } from 'express';
import type { AppEvent } from '../../../shared/events/app-event.js';
import type { EventBus, EventSubscriber } from '../../../shared/events/event-bus.js';
import type { EventsMetrics, StreamCloseReason } from '../../../shared/events/events-metrics.js';
import type { SessionStateService } from '../../auth/services/session-state.service.js';
import type {
  NotificationEventView,
  NotificationsService,
} from '../../notifications/services/notifications.service.js';
import type {
  NotificationCountEventDataDto,
  NotificationEventDataDto,
  ReadyEventDataDto,
  SessionEndedEventDataDto,
  SseEventType,
  StreamClosedEventDataDto,
} from '../dto/event.responses.js';
import { formatSseEvent, SSE_HEADERS, SSE_PING } from '../sse.js';

/** Tope de reposición con Last-Event-ID: se reponen las más recientes y ready.replayTruncated avisa. */
export const REPLAY_LIMIT = 100;
/** Ids de notificaciones ya enviadas que se recuerdan para no repetirlas (reposición y en vivo se solapan). */
const DELIVERED_MEMORY = 256;
/** Un cliente que no lee (red caída sin FIN) no acumula memoria sin límite: se corta. */
const MAX_BUFFERED_BYTES = 1024 * 1024;

export interface EventStreamDeps {
  readonly bus: EventBus;
  readonly notifications: NotificationsService;
  readonly sessions: SessionStateService;
  readonly metrics: EventsMetrics;
  readonly logger: Logger;
  readonly heartbeatMs: number;
  /** El registro lo quita al cerrarse. */
  readonly onClosed: (stream: EventStream) => void;
}

/**
 * Un stream SSE abierto (una conexión). Todo lo que lee la BD o escribe al cliente pasa por una cola en serie: el
 * orden de los eventos es el de llegada y no hay dos consultas del mismo stream a la vez.
 *
 * Ids de evento (SSE `id:`): event_seq de la notificación. El stream mantiene un cursor monótono: una notificación que
 * confirma después de otra con número mayor (transacciones concurrentes) se entrega igual, pero con id = cursor, así el
 * Last-Event-ID del navegador nunca retrocede. Solo `ready` y `notification` llevan id; los demás son estado.
 */
export class EventStream implements EventSubscriber {
  readonly openedAt = Date.now();
  private cursor = 0n;
  private readonly delivered = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private heartbeat: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private closed = false;

  constructor(
    readonly userId: string,
    readonly sessionId: string,
    private readonly res: Response,
    private readonly deps: EventStreamDeps,
  ) {}

  isClosed(): boolean {
    return this.closed;
  }

  /** Escribe las cabeceras y encola la apertura: suscribir, `ready`, reponer y empezar el latido. */
  start(lastEventId: string | null): void {
    this.res.writeHead(200, SSE_HEADERS);
    this.res.flushHeaders();
    this.res.socket?.setNoDelay(true);
    this.res.socket?.setTimeout(0);
    this.res.on('close', () => this.close('client'));
    this.deps.metrics.streamOpened(lastEventId !== null);
    this.enqueue(() => this.open(lastEventId));
  }

  event(event: AppEvent): void {
    if (event.type === 'notification' && event.refId) {
      const id = event.refId;
      this.enqueue(async () => {
        const view = await this.deps.notifications.eventView(this.userId, id);
        if (view) {
          this.sendNotification(view);
          await this.sendCount();
        }
      });
    } else if (event.type === 'notification.count') {
      this.enqueue(() => this.sendCount());
    }
  }

  resync(): void {
    this.enqueue(async () => {
      await this.replay();
      await this.sendCount();
    });
  }

  /** Cierra el stream (idempotente). finalEvent se escribe antes de cerrar si el cliente sigue ahí. */
  close(reason: StreamCloseReason, finalEvent?: { type: SseEventType; data: unknown }): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (!this.res.writableEnded) {
      if (finalEvent && !this.res.destroyed) {
        this.res.write(formatSseEvent(finalEvent.type, finalEvent.data));
        this.deps.metrics.eventDelivered(finalEvent.type);
      }
      this.res.end();
    }
    this.deps.metrics.streamClosed(reason);
    this.deps.onClosed(this);
  }

  private async open(lastEventId: string | null): Promise<void> {
    const unsubscribe = await this.deps.bus.subscribe(this.userId, this);
    if (this.closed) {
      unsubscribe();
      return;
    }
    this.unsubscribe = unsubscribe;
    // Suscrito ANTES de fijar el cursor: lo que confirme de aquí en adelante llega por el bus (y se deduplica).
    let replayTruncated = false;
    let rows: NotificationEventView[] = [];
    if (lastEventId === null) {
      this.cursor = BigInt(await this.deps.notifications.latestEventSeq(this.userId));
    } else {
      this.cursor = BigInt(lastEventId);
      ({ rows, truncated: replayTruncated } = await this.pending());
    }
    const unread = await this.deps.notifications.unreadCount(this.userId);
    const ready: ReadyEventDataDto = { unread, replayTruncated, heartbeatMs: this.deps.heartbeatMs };
    this.send('ready', ready, this.cursor.toString());
    for (const row of rows) {
      this.sendNotification(row);
    }
    if (this.closed) {
      return;
    }
    this.heartbeat = setInterval(() => this.enqueue(() => this.beat()), this.deps.heartbeatMs);
    this.heartbeat.unref();
  }

  /** Las posteriores al cursor, las más recientes primero hasta el tope, devueltas en orden ascendente. */
  private async pending(): Promise<{ rows: NotificationEventView[]; truncated: boolean }> {
    const rows = await this.deps.notifications.eventsAfter(this.userId, this.cursor.toString(), REPLAY_LIMIT + 1);
    const truncated = rows.length > REPLAY_LIMIT;
    return { rows: truncated ? rows.slice(-REPLAY_LIMIT) : rows, truncated };
  }

  private async replay(): Promise<void> {
    const { rows } = await this.pending();
    for (const row of rows) {
      this.sendNotification(row);
    }
  }

  /** Latido: revalida la sesión con la misma regla que el guard JWT; si ya no vale, `session.ended` y cierre. */
  private async beat(): Promise<void> {
    let live: unknown = true;
    try {
      live = await this.deps.sessions.resolve(this.userId, this.sessionId);
    } catch {
      // BD no disponible: no se decide sobre la sesión; se revalida en el próximo latido.
      this.deps.logger.warn('No se pudo revalidar la sesión de un stream; se reintenta en el próximo latido');
    }
    if (live === null) {
      const data: SessionEndedEventDataDto = { reason: 'SESSION_REVOKED' };
      this.close('session_ended', { type: 'session.ended', data });
      return;
    }
    this.write(SSE_PING);
  }

  private sendNotification(view: NotificationEventView): void {
    if (this.delivered.has(view.id)) {
      return;
    }
    this.remember(view.id);
    const seq = BigInt(view.seq);
    if (seq > this.cursor) {
      this.cursor = seq;
    }
    const data: NotificationEventDataDto = {
      id: view.id,
      type: view.type,
      title: view.title,
      entityType: view.entityType,
      entityId: view.entityId,
      createdAt: new Date(view.createdAt).toISOString(),
    };
    this.send('notification', data, this.cursor.toString());
  }

  private async sendCount(): Promise<void> {
    const data: NotificationCountEventDataDto = { unread: await this.deps.notifications.unreadCount(this.userId) };
    this.send('notification.count', data);
  }

  private remember(id: string): void {
    this.delivered.add(id);
    if (this.delivered.size > DELIVERED_MEMORY) {
      const oldest = this.delivered.values().next().value;
      if (oldest !== undefined) {
        this.delivered.delete(oldest);
      }
    }
  }

  private send(type: SseEventType, data: unknown, id?: string): void {
    if (this.write(formatSseEvent(type, data, id))) {
      this.deps.metrics.eventDelivered(type);
    }
  }

  private write(chunk: string): boolean {
    if (this.closed || this.res.writableEnded || this.res.destroyed) {
      return false;
    }
    if (this.res.writableLength > MAX_BUFFERED_BYTES) {
      this.close('error');
      return false;
    }
    this.res.write(chunk);
    return true;
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue
      .then(() => (this.closed ? undefined : task()))
      .catch((error: unknown) => {
        // Sin contenido ni ids: solo el tipo de error.
        this.deps.logger.error(`Error en un stream de eventos: ${error instanceof Error ? error.name : 'desconocido'}`);
      });
  }
}

/** Evento final al cerrar por reemplazo o apagado. */
export const streamClosedEvent = (
  reason: StreamClosedEventDataDto['reason'],
): { type: SseEventType; data: StreamClosedEventDataDto } => ({ type: 'stream.closed', data: { reason } });
