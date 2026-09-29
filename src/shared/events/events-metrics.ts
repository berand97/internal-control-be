import { Injectable } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';

export type StreamCloseReason = 'client' | 'session_ended' | 'replaced' | 'shutdown' | 'error';
export type StreamRejectReason = 'ticket' | 'session' | 'capacity';

export interface EventsMetricsSnapshot {
  readonly openStreams: number;
  readonly streamsOpened: number;
  readonly reconnects: number;
  readonly streamsRejected: Readonly<Record<StreamRejectReason, number>>;
  readonly streamsClosed: Readonly<Record<StreamCloseReason, number>>;
  readonly eventsDelivered: Readonly<Record<string, number>>;
  readonly busReconnects: number;
}

/**
 * Métricas del canal de eventos: contadores en proceso (snapshot, para pruebas y diagnóstico) y los mismos valores en
 * OpenTelemetry (se exportan si OTEL_EXPORTER_OTLP_* está configurado; si no, el medidor es inerte). Solo cuentan:
 * ningún atributo lleva usuarios, tickets ni contenido.
 */
@Injectable()
export class EventsMetrics {
  private readonly meter = metrics.getMeter('control-interno-be.events');
  private readonly openGauge = this.meter.createUpDownCounter('events.streams.open', {
    description: 'Streams SSE abiertos en esta instancia',
  });
  private readonly openedCounter = this.meter.createCounter('events.streams.opened', {
    description: 'Streams SSE abiertos (reconnect=true si trajo Last-Event-ID)',
  });
  private readonly rejectedCounter = this.meter.createCounter('events.streams.rejected', {
    description: 'Aperturas rechazadas por motivo',
  });
  private readonly closedCounter = this.meter.createCounter('events.streams.closed', {
    description: 'Streams cerrados por motivo',
  });
  private readonly deliveredCounter = this.meter.createCounter('events.delivered', {
    description: 'Eventos SSE escritos a los clientes, por tipo',
  });
  private readonly busReconnectCounter = this.meter.createCounter('events.bus.reconnects', {
    description: 'Reconexiones de la conexión LISTEN',
  });

  private open = 0;
  private opened = 0;
  private reconnects = 0;
  private busReconnects = 0;
  private readonly rejected: Record<StreamRejectReason, number> = { ticket: 0, session: 0, capacity: 0 };
  private readonly closed: Record<StreamCloseReason, number> = {
    client: 0,
    session_ended: 0,
    replaced: 0,
    shutdown: 0,
    error: 0,
  };
  private readonly delivered: Record<string, number> = {};

  streamOpened(reconnect: boolean): void {
    this.open += 1;
    this.opened += 1;
    if (reconnect) {
      this.reconnects += 1;
    }
    this.openGauge.add(1);
    this.openedCounter.add(1, { reconnect });
  }

  streamClosed(reason: StreamCloseReason): void {
    this.open -= 1;
    this.closed[reason] += 1;
    this.openGauge.add(-1);
    this.closedCounter.add(1, { reason });
  }

  streamRejected(reason: StreamRejectReason): void {
    this.rejected[reason] += 1;
    this.rejectedCounter.add(1, { reason });
  }

  eventDelivered(type: string): void {
    this.delivered[type] = (this.delivered[type] ?? 0) + 1;
    this.deliveredCounter.add(1, { type });
  }

  busReconnected(): void {
    this.busReconnects += 1;
    this.busReconnectCounter.add(1);
  }

  snapshot(): EventsMetricsSnapshot {
    return {
      openStreams: this.open,
      streamsOpened: this.opened,
      reconnects: this.reconnects,
      streamsRejected: { ...this.rejected },
      streamsClosed: { ...this.closed },
      eventsDelivered: { ...this.delivered },
      busReconnects: this.busReconnects,
    };
  }
}
