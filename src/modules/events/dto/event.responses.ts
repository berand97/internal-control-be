import { ApiProperty } from '@nestjs/swagger';

/**
 * Esquemas de /events. POST /events/ticket responde con el sobre JSON de siempre; GET /events es text/event-stream y
 * sus clases *EventDataDto documentan el `data` (JSON) de cada tipo de evento para que el frontend genere sus tipos.
 * Cambiar un shape exige cambiar EventStream (src/modules/events/services/event-stream.ts).
 */

export const SSE_EVENT_TYPES = [
  'ready',
  'notification',
  'notification.count',
  'session.ended',
  'stream.closed',
] as const;
export type SseEventType = (typeof SSE_EVENT_TYPES)[number];

export const SESSION_ENDED_REASONS = ['SESSION_REVOKED'] as const;
export type SessionEndedReason = (typeof SESSION_ENDED_REASONS)[number];

export const STREAM_CLOSED_REASONS = ['REPLACED', 'SHUTDOWN'] as const;
export type StreamClosedReason = (typeof STREAM_CLOSED_REASONS)[number];

export class EventTicketDto {
  @ApiProperty({
    description:
      'Ticket opaco de un solo uso para GET /events?ticket=. Ligado al usuario y a su sesión; no es un JWT. No lo guarde ni lo registre',
  })
  readonly ticket!: string;

  @ApiProperty({ type: 'string', format: 'date-time', description: 'Vence a los 30 s (EVENTS_TICKET_TTL_SECONDS)' })
  readonly expiresAt!: string;
}

export class ReadyEventDataDto {
  @ApiProperty({ type: 'integer', description: 'No leídas del usuario al abrir el stream' })
  readonly unread!: number;

  @ApiProperty({
    description:
      'true si había más de 100 notificaciones posteriores a Last-Event-ID: solo se repusieron las 100 más recientes; recargue la lista',
  })
  readonly replayTruncated!: boolean;

  @ApiProperty({
    type: 'integer',
    description: 'Cada cuántos ms llega el latido `: ping`. Sin datos en ~2 latidos, dé la conexión por caída',
  })
  readonly heartbeatMs!: number;
}

export class NotificationEventDataDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ description: 'Código del aviso (igual que NotificationDto.type)', example: 'IMPORT_FINISHED' })
  readonly type!: string;

  @ApiProperty()
  readonly title!: string;

  @ApiProperty({ type: 'string', nullable: true })
  readonly entityType!: string | null;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true })
  readonly entityId!: string | null;

  @ApiProperty({ type: 'string', format: 'date-time' })
  readonly createdAt!: string;
}

export class NotificationCountEventDataDto {
  @ApiProperty({ type: 'integer', description: 'No leídas del usuario' })
  readonly unread!: number;
}

export class SessionEndedEventDataDto {
  @ApiProperty({ enum: SESSION_ENDED_REASONS, enumName: 'SessionEndedReason' })
  readonly reason!: SessionEndedReason;
}

export class StreamClosedEventDataDto {
  @ApiProperty({
    enum: STREAM_CLOSED_REASONS,
    enumName: 'StreamClosedReason',
    description:
      'REPLACED: el usuario abrió un 4.º stream y se cerró este (el más viejo); no reconecte solo. SHUTDOWN: el servidor se reinicia; reconecte con otro ticket',
  })
  readonly reason!: StreamClosedReason;
}
