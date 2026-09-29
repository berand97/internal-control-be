import { Controller, Get, Headers, HttpCode, Post, Query, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiProperty,
  ApiPropertyOptional,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { ErrorCode } from '../../common/constants/error-code.enum.js';
import { ApiException } from '../../common/exceptions/api.exception.js';
import { ApiSuccessEnvelope, envelopedSchema, errorEnvelopeSchema } from '../../common/swagger/api-envelopes.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';
import {
  EventTicketDto,
  NotificationCountEventDataDto,
  NotificationEventDataDto,
  ReadyEventDataDto,
  SessionEndedEventDataDto,
  StreamClosedEventDataDto,
} from './dto/event.responses.js';
import { EventStreamsService, MAX_STREAMS_PER_USER } from './services/event-streams.service.js';
import { EventTicketsService } from './services/event-tickets.service.js';
import { resolveLastEventId } from './sse.js';

export class EventsStreamQueryDto {
  @ApiProperty({ description: 'Ticket de POST /events/ticket (un solo uso, 30 s)' })
  @IsString()
  @MaxLength(64)
  readonly ticket!: string;

  @ApiPropertyOptional({
    description:
      'Último id de evento recibido, para reponer lo perdido al reconectar con un ticket nuevo. La cabecera Last-Event-ID (reconexión nativa del navegador) tiene prioridad. Un valor que no sea un id del stream se ignora',
    example: '1024',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  readonly lastEventId?: string;
}

const STREAM_DESCRIPTION = `Server-Sent Events del usuario del ticket. Un solo stream multiplexado; cada evento trae \`event:\` (tipo) y \`data:\` (JSON):
- \`ready\` (ReadyEventDataDto, con \`id\`): primero, siempre.
- \`notification\` (NotificationEventDataDto, con \`id\`): notificación nueva, lo mismo que la lista sin el cuerpo.
- \`notification.count\` (NotificationCountEventDataDto): cambió el conteo de no leídas.
- \`session.ended\` (SessionEndedEventDataDto): la sesión se cerró; el servidor cierra el stream. No reconecte: renueve la sesión.
- \`stream.closed\` (StreamClosedEventDataDto): REPLACED (4.º stream del usuario; máximo ${MAX_STREAMS_PER_USER}) o SHUTDOWN.
Latido: comentario \`: ping\` cada heartbeatMs (25 s por defecto); en cada latido se revalida la sesión.
Ids: número decimal creciente (event_seq de la notificación). Al reconectar mande el último con la cabecera Last-Event-ID o \`lastEventId\`: se reponen hasta 100 notificaciones posteriores (las más recientes) antes de seguir en vivo.
No cuenta contra el límite de peticiones; el ticket sí.`;

/** Canal de eventos en tiempo real del usuario autenticado (SSE). */
@ApiTags(OpenApiTag.Auth)
@ApiExtraModels(
  ApiSuccessEnvelope,
  EventTicketDto,
  ReadyEventDataDto,
  NotificationEventDataDto,
  NotificationCountEventDataDto,
  SessionEndedEventDataDto,
  StreamClosedEventDataDto,
)
@Controller('events')
export class EventsController {
  constructor(
    private readonly tickets: EventTicketsService,
    private readonly streams: EventStreamsService,
  ) {}

  @Post('ticket')
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Ticket de un solo uso para abrir el stream de eventos',
    description:
      'EventSource no puede mandar el Bearer: se pide un ticket con la sesión normal y se abre GET /events?ticket=. Vence a los 30 s, sirve una vez y queda ligado al usuario y a su sesión. Cuenta contra el límite de peticiones por usuario.',
  })
  @ApiOkResponse({ schema: envelopedSchema(EventTicketDto) })
  async ticket(@CurrentUser() actor: AuthenticatedUser): Promise<EventTicketDto> {
    if (!actor.sessionId) {
      throw new ApiException(ErrorCode.SessionRevoked);
    }
    const issued = await this.tickets.issue({ userId: actor.id, sessionId: actor.sessionId });
    return { ticket: issued.ticket, expiresAt: issued.expiresAt.toISOString() };
  }

  @Get()
  @Public()
  @SkipThrottle()
  @ApiOperation({ summary: 'Stream de eventos en tiempo real (text/event-stream)', description: STREAM_DESCRIPTION })
  @ApiProduces('text/event-stream')
  @ApiResponse({
    status: 200,
    description: 'Stream abierto (text/event-stream). Ver la descripción para los tipos de evento',
    content: { 'text/event-stream': { schema: { type: 'string' } } },
  })
  @ApiResponse({
    status: 401,
    description:
      'EVENTS_TICKET_INVALID: ticket inexistente, usado o vencido (pida otro). SESSION_REVOKED: la sesión del ticket ya no es válida',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 503,
    description: 'EVENTS_CAPACITY_REACHED: la instancia llegó a EVENTS_MAX_STREAMS; siga con el sondeo y reintente más tarde',
    schema: errorEnvelopeSchema(),
  })
  async stream(
    @Query() query: EventsStreamQueryDto,
    @Headers('last-event-id') lastEventIdHeader: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    await this.streams.open(query.ticket, resolveLastEventId(lastEventIdHeader, query.lastEventId), res);
  }
}
