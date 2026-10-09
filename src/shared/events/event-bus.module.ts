import { Module } from '@nestjs/common';
import { EVENT_BUS } from './event-bus.js';
import { EventsMetrics } from './events-metrics.js';
import { PgEventBus } from './pg-event-bus.js';
import { PgListener } from './pg-listener.js';

/**
 * Bus de eventos de la aplicación (una instancia por proceso): lo publican los servicios y lo leen los streams SSE.
 * PgListener es la conexión LISTEN compartida del proceso (también la usa la caché de módulos).
 */
@Module({
  providers: [EventsMetrics, PgListener, PgEventBus, { provide: EVENT_BUS, useExisting: PgEventBus }],
  exports: [EVENT_BUS, EventsMetrics, PgEventBus, PgListener],
})
export class EventBusModule {}
