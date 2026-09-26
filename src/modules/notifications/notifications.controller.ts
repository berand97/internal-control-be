import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOkResponse, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { ApiSuccessEnvelope, envelopedSchema } from '../../common/swagger/api-envelopes.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';
import {
  NotificationDto,
  NotificationPageDto,
  NotificationsMarkedDto,
  NotificationUnreadCountDto,
} from './dto/notification.responses.js';
import { NotificationsService } from './services/notifications.service.js';

export class NotificationsQueryDto {
  @ApiPropertyOptional({ description: 'true: solo no leídas', default: false })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  readonly unread: boolean = false;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  readonly page: number = 1;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  readonly pageSize: number = 20;
}

/** Avisos en la app del usuario autenticado (campana). Sin permiso extra: cada quien ve solo los suyos. */
@ApiTags(OpenApiTag.Auth)
@ApiBearerAuth()
@ApiExtraModels(ApiSuccessEnvelope, NotificationDto, NotificationPageDto, NotificationUnreadCountDto, NotificationsMarkedDto)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'Mis notificaciones, más recientes primero' })
  @ApiOkResponse({ schema: envelopedSchema(NotificationPageDto) })
  list(@Query() query: NotificationsQueryDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.notifications.list(actor.id, { unreadOnly: query.unread, page: query.page, pageSize: query.pageSize });
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Cuántas notificaciones no leídas tengo (para la campana)' })
  @ApiOkResponse({ schema: envelopedSchema(NotificationUnreadCountDto) })
  async unreadCount(@CurrentUser() actor: AuthenticatedUser): Promise<NotificationUnreadCountDto> {
    return { count: await this.notifications.unreadCount(actor.id) };
  }

  @Post('read-all')
  @HttpCode(200)
  @ApiOperation({ summary: 'Marcar todas mis notificaciones como leídas' })
  @ApiOkResponse({ schema: envelopedSchema(NotificationsMarkedDto) })
  async markAllRead(@CurrentUser() actor: AuthenticatedUser): Promise<NotificationsMarkedDto> {
    return { updated: await this.notifications.markAllRead(actor.id) };
  }

  @Post(':id/read')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Marcar una notificación como leída',
    description: 'Idempotente (conserva la primera fecha de lectura). 404 RESOURCE_NOT_FOUND si no existe o es de otro usuario.',
  })
  @ApiOkResponse({ schema: envelopedSchema(NotificationDto) })
  markRead(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.notifications.markRead(actor.id, id);
  }
}
