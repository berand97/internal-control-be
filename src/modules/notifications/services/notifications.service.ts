import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';

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

const COLUMNS = `id, notification_type AS type, title, body, entity_type AS "entityType", entity_id AS "entityId",
  read_at AS "readAt", created_at AS "createdAt"`;

/** Notificaciones en la app (tabla notification). Cada usuario ve y marca solo las suyas. */
@Injectable()
export class NotificationsService {
  constructor(private readonly dataSource: DataSource) {}

  /** Siempre dentro de la transacción del hecho que se notifica. */
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
    return row?.id ?? '';
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
  async markRead(userId: string, id: string): Promise<NotificationView> {
    // Con UPDATE el driver de PostgreSQL devuelve [filas de RETURNING, filas afectadas].
    const [rows] = (await this.dataSource.query(
      `UPDATE notification SET read_at = coalesce(read_at, NOW())
       WHERE id = $1 AND recipient_user_id = $2 RETURNING ${COLUMNS}`,
      [id, userId],
    )) as [NotificationView[], number];
    const updated = rows[0];
    if (!updated) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'No existe la notificación');
    }
    return updated;
  }

  async markAllRead(userId: string): Promise<number> {
    const [, affected] = (await this.dataSource.query(
      'UPDATE notification SET read_at = NOW() WHERE recipient_user_id = $1 AND read_at IS NULL',
      [userId],
    )) as [unknown, number];
    return affected ?? 0;
  }
}
