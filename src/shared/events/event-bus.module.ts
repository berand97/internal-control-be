import { Module } from '@nestjs/common';
import { EVENT_BUS } from './event-bus.js';
import { EventsMetrics } from './events-metrics.js';
import { PgEventBus } from './pg-event-bus.js';

/** Bus de eventos de la aplicación (una instancia por proceso): lo publican los servicios y lo leen los streams SSE. */
@Module({
  providers: [EventsMetrics, PgEventBus, { provide: EVENT_BUS, useExisting: PgEventBus }],
  exports: [EVENT_BUS, EventsMetrics, PgEventBus],
})
export class EventBusModule {}
