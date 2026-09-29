import { Module } from '@nestjs/common';
import { EventBusModule } from '../../shared/events/event-bus.module.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './services/notifications.service.js';

@Module({
  imports: [EventBusModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
