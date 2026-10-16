import { Module } from '@nestjs/common';
import { EVENT_BUS } from './event-bus.js';
import { EventsMetrics } from './events-metrics.js';
import { PgEventBus } from './pg-event-bus.js';
import { PgListener } from './pg-listener.js';

@Module({
  providers: [EventsMetrics, PgListener, PgEventBus, { provide: EVENT_BUS, useExisting: PgEventBus }],
  exports: [EVENT_BUS, EventsMetrics, PgEventBus, PgListener],
})
export class EventBusModule {}
