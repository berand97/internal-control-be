import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { AppConfig } from '../../../config/configuration.js';

export interface IssuedEventTicket {
  readonly ticket: string;
  readonly expiresAt: Date;
}

export interface EventTicketOwner {
  readonly userId: string;
  readonly sessionId: string;
}

/** 32 bytes aleatorios en base64url (43 caracteres). */
const TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const hashTicket = (ticket: string): Buffer => createHash('sha256').update(ticket, 'utf8').digest();

/**
 * Tickets de un solo uso para abrir GET /events: EventSource no puede mandar el Bearer y el JWT nunca va en la URL.
 * - En tabla (event_stream_ticket) y no en memoria: con dos instancias, el ticket emitido en una se consume en la otra;
 *   con una sola cuesta un INSERT y un DELETE por conexión.
 * - Solo se guarda el SHA-256 (clave primaria = búsqueda por índice); el valor en claro vive en la respuesta y la URL.
 * - Consumo atómico: DELETE ... RETURNING. Dos peticiones con el mismo ticket: solo una obtiene la fila.
 * - Los vencidos se purgan al emitir (índice por expires_at): la tabla no crece.
 */
@Injectable()
export class EventTicketsService {
  private readonly ttlSeconds: number;

  constructor(
    private readonly dataSource: DataSource,
    config: ConfigService<AppConfig, true>,
  ) {
    this.ttlSeconds = config.getOrThrow('events.ticketTtlSeconds', { infer: true });
  }

  async issue(owner: EventTicketOwner): Promise<IssuedEventTicket> {
    const ticket = randomBytes(32).toString('base64url');
    await this.dataSource.query('DELETE FROM event_stream_ticket WHERE expires_at < NOW()');
    const [row] = (await this.dataSource.query(
      `INSERT INTO event_stream_ticket (token_hash, user_id, session_id, expires_at)
       VALUES ($1, $2, $3, NOW() + make_interval(secs => $4)) RETURNING expires_at AS "expiresAt"`,
      [hashTicket(ticket), owner.userId, owner.sessionId, this.ttlSeconds],
    )) as Array<{ expiresAt: Date }>;
    return { ticket, expiresAt: row?.expiresAt ?? new Date() };
  }

  /** Lo borra y devuelve su dueño; null si no existe, ya se usó o venció (un vencido también se borra). */
  async consume(ticket: string): Promise<EventTicketOwner | null> {
    if (!TICKET_PATTERN.test(ticket)) {
      return null;
    }
    const [rows] = (await this.dataSource.query(
      `DELETE FROM event_stream_ticket WHERE token_hash = $1
       RETURNING user_id AS "userId", session_id AS "sessionId", expires_at > NOW() AS live`,
      [hashTicket(ticket)],
    )) as [Array<{ userId: string; sessionId: string; live: boolean }>, number];
    const row = rows[0];
    return row?.live ? { userId: row.userId, sessionId: row.sessionId } : null;
  }
}
