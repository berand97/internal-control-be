import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AppConfig } from '../../../config/configuration.js';
import { EVENT_BUS, type EventBus } from '../../../shared/events/event-bus.js';
import { EventsMetrics } from '../../../shared/events/events-metrics.js';
import { SessionStateService } from '../../auth/services/session-state.service.js';
import { NotificationsService } from '../../notifications/services/notifications.service.js';
import { EventStream, streamClosedEvent } from './event-stream.js';
import { EventTicketsService } from './event-tickets.service.js';

/**
 * Streams simultáneos por usuario. El frontend abre uno por navegador (pestaña líder): 3 cubre PC, portátil y móvil.
 * Al abrir el 4.º se cierra el MÁS VIEJO con `stream.closed` REPLACED en vez de rechazar el nuevo con 429: el más
 * viejo es el que con más probabilidad está muerto sin saberlo (portátil suspendido, red caída sin FIN, que el proxy
 * aún no cortó); rechazar dejaría al usuario sin tiempo real hasta que esas conexiones zombi venzan. El reemplazado
 * no debe reconectar solo (el frontend cae a su sondeo lento), así dos dispositivos no se expulsan en bucle.
 */
export const MAX_STREAMS_PER_USER = 3;

/** Registro de los streams SSE de esta instancia: límites, apertura y cierre ordenado al apagar. */
@Injectable()
export class EventStreamsService implements OnModuleDestroy {
  private readonly logger = new Logger('EventStreams');
  private readonly byUser = new Map<string, EventStream[]>();
  private total = 0;
  private readonly maxStreams: number;
  private readonly heartbeatMs: number;
  private shuttingDown = false;

  constructor(
    private readonly tickets: EventTicketsService,
    private readonly sessions: SessionStateService,
    private readonly notifications: NotificationsService,
    private readonly metrics: EventsMetrics,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    config: ConfigService<AppConfig, true>,
  ) {
    this.maxStreams = config.getOrThrow('events.maxStreams', { infer: true });
    this.heartbeatMs = config.getOrThrow('events.heartbeatMs', { infer: true });
  }

  /**
   * Consume el ticket y abre el stream. Antes de escribir cabeceras lanza (JSON de error de siempre):
   * 401 EVENTS_TICKET_INVALID, 401 SESSION_REVOKED, 503 EVENTS_CAPACITY_REACHED.
   */
  async open(ticket: string, lastEventId: string | null, res: Response): Promise<void> {
    const owner = await this.tickets.consume(ticket);
    if (!owner) {
      this.metrics.streamRejected('ticket');
      throw new ApiException(ErrorCode.EventsTicketInvalid);
    }
    if ((await this.sessions.resolve(owner.userId, owner.sessionId)) === null) {
      this.metrics.streamRejected('session');
      throw new ApiException(ErrorCode.SessionRevoked);
    }
    const own = this.byUser.get(owner.userId) ?? [];
    const evicts = own.length >= MAX_STREAMS_PER_USER;
    if (this.shuttingDown || (!evicts && this.total >= this.maxStreams)) {
      this.metrics.streamRejected('capacity');
      throw new ApiException(ErrorCode.EventsCapacityReached);
    }
    if (evicts) {
      own[0]?.close('replaced', streamClosedEvent('REPLACED'));
    }
    const stream = new EventStream(owner.userId, owner.sessionId, res, {
      bus: this.bus,
      notifications: this.notifications,
      sessions: this.sessions,
      metrics: this.metrics,
      logger: this.logger,
      heartbeatMs: this.heartbeatMs,
      onClosed: (closed) => this.remove(closed),
    });
    this.add(stream);
    stream.start(lastEventId);
    this.logger.debug(`Stream abierto (${this.total} en la instancia)`);
  }

  /** Streams abiertos de un usuario en esta instancia (pruebas y diagnóstico). */
  openFor(userId: string): number {
    return this.byUser.get(userId)?.length ?? 0;
  }

  openTotal(): number {
    return this.total;
  }

  onModuleDestroy(): void {
    this.shuttingDown = true;
    const all = [...this.byUser.values()].flat();
    for (const stream of all) {
      stream.close('shutdown', streamClosedEvent('SHUTDOWN'));
    }
    if (all.length > 0) {
      this.logger.log(`${all.length} streams cerrados al apagar`);
    }
  }

  private add(stream: EventStream): void {
    const own = this.byUser.get(stream.userId);
    if (own) {
      own.push(stream);
    } else {
      this.byUser.set(stream.userId, [stream]);
    }
    this.total += 1;
  }

  private remove(stream: EventStream): void {
    const own = this.byUser.get(stream.userId);
    const index = own?.indexOf(stream) ?? -1;
    if (!own || index < 0) {
      return;
    }
    own.splice(index, 1);
    if (own.length === 0) {
      this.byUser.delete(stream.userId);
    }
    this.total -= 1;
    this.logger.debug(`Stream cerrado (${this.total} en la instancia)`);
  }
}
