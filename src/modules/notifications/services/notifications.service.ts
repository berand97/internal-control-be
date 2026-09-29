import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import { EVENT_BUS, type EventBus } from '../../../shared/events/event-bus.js';

export interface NewNotification {
  readonly recipientUserId: string;
  /** Código estable (VARCHAR 50). Hoy: IMPORT_FINISHED, IMPORT_FAILED. */
  readonly type: string;
  readonly title: string;
  readonly body: string | null;
  readonly entityType: string | null;
  readonly entityId: string | null;
}

export interface NotificationView {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly body: string | null;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly readAt: Date | null;
  readonly createdAt: Date;
}

export interface NotificationPage {
  readonly items: ReadonlyArray<NotificationView>;
  readonly total: number;
  readonly unread: number;
  readonly page: number;
  readonly pageSize: number;
}

/**
 * Lo que el stream de eventos (GET /events) manda de una notificación: lo mismo que el usuario ya ve en su lista,
 * sin el cuerpo. seq = notification.event_seq (id del evento SSE, BIGINT como texto).
 */
export interface NotificationEventView {
  readonly seq: string;
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly createdAt: Date;
}

const COLUMNS = `id, notification_type AS type, title, body, entity_type AS "entityType", entity_id AS "entityId",
  read_at AS "readAt", created_at AS "createdAt"`;

const EVENT_COLUMNS = `event_seq::text AS seq, id, notification_type AS type, title, entity_type AS "entityType",
  entity_id AS "entityId", created_at AS "createdAt"`;

/** Notificaciones en la app (tabla notification). Cada usuario ve y marca solo las suyas. */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly dataSource: DataSource,
    @Inject(EVENT_BUS) private readonly events: EventBus,
  ) {}

  /**
   * Siempre dentro de la transacción del hecho que se notifica. Publica el evento `notification` en la misma
   * transacción: el stream del destinatario lo recibe solo si confirma.
   */
  async create(manager: EntityManager, notification: NewNotification): Promise<string> {
    const [row] = (await manager.query(
      `INSERT INTO notification (recipient_user_id, notification_type, title, body, entity_type, entity_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        notification.recipientUserId,
        notification.type,
        notification.title.slice(0, 200),
        notification.body,
        notification.entityType,
        notification.entityId,
      ],
    )) as Array<{ id: string }>;
    const id = row?.id ?? '';
    if (id) {
      await this.events.publish(manager, { userId: notification.recipientUserId, type: 'notification', refId: id });
    }
    return id;
  }

  async list(userId: string, options: { unreadOnly: boolean; page: number; pageSize: number }): Promise<NotificationPage> {
    const filter = options.unreadOnly ? 'AND read_at IS NULL' : '';
    const items = (await this.dataSource.query(
      `SELECT ${COLUMNS} FROM notification WHERE recipient_user_id = $1 ${filter}
       ORDER BY created_at DESC, id LIMIT $2 OFFSET $3`,
      [userId, options.pageSize, (options.page - 1) * options.pageSize],
    )) as NotificationView[];
    const [counts] = (await this.dataSource.query(
      `SELECT count(*) FILTER (WHERE TRUE ${filter})::int AS total, count(*) FILTER (WHERE read_at IS NULL)::int AS unread
       FROM notification WHERE recipient_user_id = $1`,
      [userId],
    )) as Array<{ total: number; unread: number }>;
    return { items, total: counts?.total ?? 0, unread: counts?.unread ?? 0, page: options.page, pageSize: options.pageSize };
  }

  async unreadCount(userId: string): Promise<number> {
    const [row] = (await this.dataSource.query(
      'SELECT count(*)::int AS count FROM notification WHERE recipient_user_id = $1 AND read_at IS NULL',
      [userId],
    )) as Array<{ count: number }>;
    return row?.count ?? 0;
  }

  /** Idempotente: marcar otra vez una leída conserva su read_at. De otro usuario o inexistente: 404. */
  /** Publica `notification.count` en la misma transacción (los streams del usuario recuentan tras el COMMIT). */
  async markRead(userId: string, id: string): Promise<NotificationView> {
    return this.dataSource.transaction(async (manager) => {
      // Con UPDATE el driver de PostgreSQL devuelve [filas de RETURNING, filas afectadas].
      const [rows] = (await manager.query(
        `UPDATE notification SET read_at = coalesce(read_at, NOW())
         WHERE id = $1 AND recipient_user_id = $2 RETURNING ${COLUMNS}`,
        [id, userId],
      )) as [NotificationView[], number];
      const updated = rows[0];
      if (!updated) {
        throw new ApiException(ErrorCode.ResourceNotFound, 'No existe la notificación');
      }
      await this.events.publish(manager, { userId, type: 'notification.count', refId: null });
      return updated;
    });
  }

  async markAllRead(userId: string): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      const [, affected] = (await manager.query(
        'UPDATE notification SET read_at = NOW() WHERE recipient_user_id = $1 AND read_at IS NULL',
        [userId],
      )) as [unknown, number];
      if ((affected ?? 0) > 0) {
        await this.events.publish(manager, { userId, type: 'notification.count', refId: null });
      }
      return affected ?? 0;
    });
  }

  /** Una notificación del usuario para el stream; null si no existe o es de otro. */
  async eventView(userId: string, id: string): Promise<NotificationEventView | null> {
    const [row] = (await this.dataSource.query(
      `SELECT ${EVENT_COLUMNS} FROM notification WHERE id = $1 AND recipient_user_id = $2`,
      [id, userId],
    )) as NotificationEventView[];
    return row ?? null;
  }

  /**
   * Reposición con Last-Event-ID: las `limit` MÁS RECIENTES del usuario con event_seq > afterSeq, devueltas en orden
   * ascendente de event_seq.
   */
  async eventsAfter(userId: string, afterSeq: string, limit: number): Promise<NotificationEventView[]> {
    const rows = (await this.dataSource.query(
      `SELECT ${EVENT_COLUMNS} FROM notification
       WHERE recipient_user_id = $1 AND event_seq > $2::bigint ORDER BY event_seq DESC LIMIT $3`,
      [userId, afterSeq, limit],
    )) as NotificationEventView[];
    return rows.reverse();
  }

  /** Último event_seq del usuario ('0' si no tiene): cursor inicial de un stream sin Last-Event-ID. */
  async latestEventSeq(userId: string): Promise<string> {
    const [row] = (await this.dataSource.query(
      'SELECT coalesce(max(event_seq), 0)::text AS seq FROM notification WHERE recipient_user_id = $1',
      [userId],
    )) as Array<{ seq: string }>;
    return row?.seq ?? '0';
  }
}
