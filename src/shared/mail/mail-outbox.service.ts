import { Injectable, Logger } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import type { EmailTemplateType } from '../../modules/email-templates/domain/email-template-catalog.js';
import { MAIL_OUTBOX_STATUSES, type MailOutboxStatus } from './mail-outbox-status.js';
import { MailService } from './mail.service.js';

export const MAX_OUTBOX_SEND_ATTEMPTS = 3;
export const OUTBOX_RETRY_MINUTES = 5;

export { MAIL_OUTBOX_STATUSES, type MailOutboxStatus };

export type MailOutboxRecipient =
  | { readonly recipientUserId: string; readonly recipientPersonId?: never }
  | { readonly recipientPersonId: string; readonly recipientUserId?: never };

export type MailOutboxEntry = MailOutboxRecipient & {
  readonly templateType: EmailTemplateType;
  readonly context: Record<string, string>;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly templateVersionId?: string | null;
};

export interface MailOutboxState {
  readonly status: MailOutboxStatus;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly sentAt: Date | null;
}

@Injectable()
export class MailOutboxService {
  private readonly logger = new Logger(MailOutboxService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly mail: MailService,
  ) {}

  async enqueue(manager: EntityManager, entry: MailOutboxEntry): Promise<string> {
    const [row] = (await manager.query(
      `INSERT INTO mail_outbox
         (template_type, recipient_user_id, recipient_person_id, context, entity_type, entity_id, template_version_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        entry.templateType,
        entry.recipientUserId ?? null,
        entry.recipientPersonId ?? null,
        JSON.stringify(entry.context),
        entry.entityType,
        entry.entityId,
        entry.templateVersionId ?? null,
      ],
    )) as Array<{ id: string }>;
    return row?.id ?? '';
  }

  async stateOf(id: string): Promise<MailOutboxState | null> {
    const [row] = (await this.dataSource.query(
      `SELECT delivery_status, send_attempts, last_send_error, sent_at FROM mail_outbox WHERE id = $1`,
      [id],
    )) as Array<{ delivery_status: MailOutboxStatus; send_attempts: number; last_send_error: string | null; sent_at: Date | null }>;
    return row
      ? { status: row.delivery_status, attempts: row.send_attempts, lastError: row.last_send_error, sentAt: row.sent_at }
      : null;
  }

  async dispatchNow(id: string): Promise<'SENT' | 'FAILED' | 'SKIPPED'> {
    return this.dispatchOne(id);
  }

  async latestFor(entityType: string, entityId: string): Promise<MailOutboxState | null> {
    const [row] = (await this.dataSource.query(
      `SELECT delivery_status, send_attempts, last_send_error, sent_at FROM mail_outbox
       WHERE entity_type = $1 AND entity_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [entityType, entityId],
    )) as Array<{ delivery_status: MailOutboxStatus; send_attempts: number; last_send_error: string | null; sent_at: Date | null }>;
    return row
      ? { status: row.delivery_status, attempts: row.send_attempts, lastError: row.last_send_error, sentAt: row.sent_at }
      : null;
  }

  async dispatchPending(limit = 20): Promise<{ sent: number; failed: number }> {
    const due = (await this.dataSource.query(
      `SELECT id FROM mail_outbox
       WHERE (delivery_status = 'PENDING_SEND' OR (delivery_status = 'FAILED' AND send_attempts < $2))
         AND (send_started_at IS NULL OR send_started_at < NOW() - make_interval(mins => $3))
       ORDER BY created_at LIMIT $1`,
      [limit, MAX_OUTBOX_SEND_ATTEMPTS, OUTBOX_RETRY_MINUTES],
    )) as Array<{ id: string }>;
    let sent = 0;
    let failed = 0;
    for (const { id } of due) {
      const outcome = await this.dispatchOne(id).catch((error: unknown) => {
        this.logger.error(`No se pudo procesar el correo ${id}`, error instanceof Error ? error.stack : String(error));
        return 'FAILED' as const;
      });
      sent += outcome === 'SENT' ? 1 : 0;
      failed += outcome === 'FAILED' ? 1 : 0;
    }
    return { sent, failed };
  }

  private async dispatchOne(id: string): Promise<'SENT' | 'FAILED' | 'SKIPPED'> {
    const claimed = await this.dataSource.transaction(async (manager) => {
      const [mail] = (await manager.query(
        `SELECT o.template_type, o.context, o.template_version_id, p.email,
                nullif(trim(concat_ws(' ', p.first_name, p.last_name)), '') AS full_name
         FROM mail_outbox o
         LEFT JOIN app_user u ON u.id = o.recipient_user_id
         LEFT JOIN person p ON p.id = coalesce(o.recipient_person_id, u.person_id)
         WHERE o.id = $1
           AND (o.delivery_status = 'PENDING_SEND' OR (o.delivery_status = 'FAILED' AND o.send_attempts < $2))
           AND (o.send_started_at IS NULL OR o.send_started_at < NOW() - make_interval(mins => $3))
         FOR UPDATE OF o SKIP LOCKED`,
        [id, MAX_OUTBOX_SEND_ATTEMPTS, OUTBOX_RETRY_MINUTES],
      )) as Array<{
        template_type: EmailTemplateType;
        context: Record<string, string>;
        template_version_id: string | null;
        email: string | null;
        full_name: string | null;
      }>;
      if (!mail) {
        return null;
      }
      await manager.query(
        'UPDATE mail_outbox SET send_started_at = NOW(), send_attempts = send_attempts + 1 WHERE id = $1',
        [id],
      );
      return mail;
    });
    if (!claimed) {
      return 'SKIPPED';
    }
    let error: string | null = null;
    if (!claimed.email) {
      error = 'El destinatario no tiene correo registrado';
    } else {
      try {
        const delivered = await this.mail.sendTemplated(
          claimed.template_type,
          claimed.email,
          { 'user.fullName': claimed.full_name ?? '', ...claimed.context },
          `mail-outbox id=${id} template=${claimed.template_type}`,
          claimed.template_version_id,
        );
        if (!delivered) {
          error = 'El correo saliente (SMTP) no está configurado o está deshabilitado';
        }
      } catch (cause) {
        error = cause instanceof Error ? cause.message.slice(0, 500) : 'Falló el envío del correo';
      }
    }
    await this.dataSource.query(
      `UPDATE mail_outbox SET delivery_status = $2::text, last_send_error = $3,
         sent_at = CASE WHEN $2::text = 'SENT' THEN NOW() ELSE sent_at END
       WHERE id = $1`,
      [id, error ? 'FAILED' : 'SENT', error],
    );
    if (error) {
      this.logger.warn(`El correo ${id} no se envió: ${error}`);
    }
    return error ? 'FAILED' : 'SENT';
  }
}
