import { Module } from '@nestjs/common';
import { EventBusModule } from '../../shared/events/event-bus.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { EventsController } from './events.controller.js';
import { EventStreamsService } from './services/event-streams.service.js';
import { EventTicketsService } from './services/event-tickets.service.js';

/** Canal de eventos en tiempo real (SSE): ticket, stream por usuario y reparto por el EventBus. */
@Module({
  imports: [AuthModule, EventBusModule, NotificationsModule],
  controllers: [EventsController],
  providers: [EventTicketsService, EventStreamsService],
  exports: [EventStreamsService],
})
export class EventsModule {}
