import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AppConfig } from '../../../config/configuration.js';
import { MailService } from '../../../shared/mail/mail.service.js';
import { findFormat } from '../domain/document-formats.js';
import {
  channelFor,
  LINK_SEND_RETRY_MINUTES,
  MAX_LINK_SEND_ATTEMPTS,
  SIGNING_LINK_TTL_HOURS,
  type SignerCandidate,
  type TurnChannel,
} from '../domain/signing-channel.js';

export const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

/** 32 bytes aleatorios en base64url (43 caracteres). Solo su SHA-256 se guarda. */
export const newSecret = (): string => randomBytes(32).toString('base64url');

export type LinkInvalidation = 'RESENT' | 'ATTEMPTS_EXCEEDED' | 'REASSIGNED' | 'VOIDED' | 'TURN_CHANGED';

export interface SigningLinkRow {
  id: string;
  document_id: string;
  sign_order: number;
  person_id: string;
  email: string;
  token_hash: string | null;
  delivery_status: 'PENDING_SEND' | 'SENT' | 'FAILED';
  send_attempts: number;
  last_send_error: string | null;
  sent_at: Date | null;
  expires_at: Date | null;
  identity_attempts: number;
  identity_confirmed_at: Date | null;
  authorization_hash: string | null;
  authorization_expires_at: Date | null;
  consumed_at: Date | null;
  consumed_action: 'SIGNED' | 'REJECTED' | null;
  invalidated_at: Date | null;
  invalidated_reason: LinkInvalidation | null;
  created_at: Date;
}

/** Estado del enlace como lo ve quien administra el proceso (detalle del documento). */
export type SigningLinkState = 'PENDING_SEND' | 'SENT' | 'SEND_FAILED' | 'EXPIRED' | 'CONSUMED' | 'INVALIDATED';

export const linkState = (link: SigningLinkRow, now = new Date()): SigningLinkState => {
  if (link.consumed_at) {
    return 'CONSUMED';
  }
  if (link.invalidated_at) {
    return 'INVALIDATED';
  }
  if (link.expires_at && new Date(link.expires_at) <= now) {
    return 'EXPIRED';
  }
  return link.delivery_status === 'FAILED' ? 'SEND_FAILED' : link.delivery_status;
};

const OPEN = 'consumed_at IS NULL AND invalidated_at IS NULL';

const bogotaDateTime = (date: Date): string =>
  new Intl.DateTimeFormat('es-CO', { dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Bogota' }).format(date);

/**
 * Enlaces de firma por correo (camino EMAIL_LINK) y su outbox.
 *
 * - El enlace se crea (PENDING_SEND) cuando el turno de una persona sin usuario activo pasa a ser el actual, o cuando
 *   quien administra el proceso lo reenvía (invalida el anterior). Crear el enlace nunca envía correo.
 * - dispatchPending (job de cada minuto y, sin esperar al job, justo después de crear el enlace) emite el token en su
 *   propia transacción, envía el correo FUERA de la transacción y registra SENT o FAILED con el error.
 * - El token solo existe en el correo: en BD queda su SHA-256.
 */
@Injectable()
export class SigningLinkService {
  private readonly logger = new Logger(SigningLinkService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly mail: MailService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  signingUrl(token: string): string {
    return `${this.config.getOrThrow('appPublicUrl', { infer: true }).replace(/\/+$/, '')}/firmar/${token}`;
  }

  async candidate(manager: EntityManager, personId: string | null): Promise<SignerCandidate | null> {
    if (!personId) {
      return null;
    }
    const [row] = (await manager.query(
      `SELECT p.id, p.is_active, p.email, p.document_number, u.status AS user_status, coalesce(u.mfa_enabled, FALSE) AS mfa_enabled
       FROM person p LEFT JOIN app_user u ON u.person_id = p.id WHERE p.id = $1`,
      [personId],
    )) as Array<{
      id: string;
      is_active: boolean;
      email: string | null;
      document_number: string | null;
      user_status: string | null;
      mfa_enabled: boolean;
    }>;
    return row
      ? {
          personId: row.id,
          personActive: row.is_active,
          email: row.email,
          documentNumber: row.document_number,
          userStatus: row.user_status,
          mfaEnabled: row.mfa_enabled,
        }
      : null;
  }

  async channel(manager: EntityManager, role: string, personId: string | null): Promise<TurnChannel> {
    return channelFor(role, await this.candidate(manager, personId));
  }

  /** Turno actual del acta: el primer PENDING, si el acta sigue pendiente y nadie rechazó. */
  async currentTurn(
    manager: EntityManager,
    documentId: string,
  ): Promise<{ sign_order: number; role: string; signer_person_id: string | null } | null> {
    const [document] = (await manager.query('SELECT status FROM document WHERE id = $1', [documentId])) as Array<{
      status: string;
    }>;
    const slots = (await manager.query(
      'SELECT sign_order, role, signer_person_id, status FROM document_signature WHERE document_id = $1 ORDER BY sign_order',
      [documentId],
    )) as Array<{ sign_order: number; role: string; signer_person_id: string | null; status: string }>;
    if (document?.status !== 'PENDING_SIGNATURE' || slots.some((slot) => slot.status === 'REJECTED')) {
      return null;
    }
    return slots.find((slot) => slot.status === 'PENDING') ?? null;
  }

  /**
   * Deja el enlace del turno actual como corresponde: invalida los enlaces abiertos de turnos que ya no son el actual
   * y, si el turno actual se firma por enlace y esa persona aún no tiene uno, lo crea. Luego intenta enviarlo.
   * No crea otro si ya hubo uno para la misma persona y turno (vencido, usado o bloqueado): eso lo decide un reenvío.
   */
  async refresh(documentId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT id FROM document WHERE id = $1 FOR UPDATE', [documentId]);
      const current = await this.currentTurn(manager, documentId);
      await manager.query(
        `UPDATE signature_signing_link SET invalidated_at = NOW(), invalidated_reason = 'TURN_CHANGED'
         WHERE document_id = $1 AND ${OPEN} AND ($2::int IS NULL OR sign_order <> $2 OR person_id IS DISTINCT FROM $3::uuid)`,
        [documentId, current?.sign_order ?? null, current?.signer_person_id ?? null],
      );
      if (!current?.signer_person_id) {
        return;
      }
      const candidate = await this.candidate(manager, current.signer_person_id);
      if (channelFor(current.role, candidate).channel !== 'EMAIL_LINK' || !candidate?.email) {
        return;
      }
      const [previous] = (await manager.query(
        `SELECT 1 AS found FROM signature_signing_link
         WHERE document_id = $1 AND sign_order = $2 AND person_id = $3
           AND (invalidated_reason IS NULL OR invalidated_reason <> 'REASSIGNED')
         LIMIT 1`,
        [documentId, current.sign_order, current.signer_person_id],
      )) as Array<{ found: number }>;
      if (previous) {
        return;
      }
      await manager.query(
        `INSERT INTO signature_signing_link (document_id, sign_order, person_id, email)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [documentId, current.sign_order, current.signer_person_id, candidate.email],
      );
    });
    await this.dispatchPending(20, documentId);
  }

  /** Reenvío por quien administra el proceso: invalida el enlace abierto del turno y crea uno nuevo. */
  async resend(documentId: string, order: number, actorId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT id FROM document WHERE id = $1 FOR UPDATE', [documentId]);
      const current = await this.currentTurn(manager, documentId);
      if (!current || current.sign_order !== order) {
        throw new ApiException(ErrorCode.SignatureLinkNotApplicable, `El turno ${order} no es el turno actual del acta`);
      }
      const candidate = await this.candidate(manager, current.signer_person_id);
      const channel = channelFor(current.role, candidate);
      if (channel.blockedBy) {
        throw new ApiException(channel.blockedBy);
      }
      if (channel.channel !== 'EMAIL_LINK' || !candidate?.email) {
        throw new ApiException(
          ErrorCode.SignatureLinkNotApplicable,
          'La persona de este turno firma con su sesión en el sistema, no por enlace',
        );
      }
      await this.invalidate(manager, documentId, 'RESENT', order);
      await manager.query(
        `INSERT INTO signature_signing_link (document_id, sign_order, person_id, email, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [documentId, order, current.signer_person_id, candidate.email, actorId],
      );
    });
    await this.dispatchPending(20, documentId);
  }

  async invalidate(manager: EntityManager, documentId: string, reason: LinkInvalidation, order?: number): Promise<void> {
    await manager.query(
      `UPDATE signature_signing_link SET invalidated_at = NOW(), invalidated_reason = $3,
         authorization_hash = NULL, authorization_expires_at = NULL
       WHERE document_id = $1 AND ${OPEN} AND ($2::int IS NULL OR sign_order = $2)`,
      [documentId, order ?? null, reason],
    );
  }

  /** Outbox del correo: emite token y envía. Un fallo queda en el enlace (FAILED + last_send_error), nunca se pierde. */
  async dispatchPending(limit = 20, documentId?: string): Promise<{ sent: number; failed: number }> {
    const due = (await this.dataSource.query(
      `SELECT id FROM signature_signing_link
       WHERE ${OPEN} AND (delivery_status = 'PENDING_SEND' OR (delivery_status = 'FAILED' AND send_attempts < $2))
         AND (send_started_at IS NULL OR send_started_at < NOW() - make_interval(mins => $3))
         AND ($4::uuid IS NULL OR document_id = $4)
       ORDER BY created_at LIMIT $1`,
      [limit, MAX_LINK_SEND_ATTEMPTS, LINK_SEND_RETRY_MINUTES, documentId ?? null],
    )) as Array<{ id: string }>;
    let sent = 0;
    let failed = 0;
    for (const { id } of due) {
      const outcome = await this.dispatchOne(id).catch((error: unknown) => {
        this.logger.error(`No se pudo procesar el enlace de firma ${id}`, error instanceof Error ? error.stack : String(error));
        return 'FAILED' as const;
      });
      sent += outcome === 'SENT' ? 1 : 0;
      failed += outcome === 'FAILED' ? 1 : 0;
    }
    return { sent, failed };
  }

  private async dispatchOne(id: string): Promise<'SENT' | 'FAILED' | 'SKIPPED'> {
    const token = newSecret();
    const tokenHash = sha256Hex(token);
    const claimed = await this.dataSource.transaction(async (manager) => {
      const [link] = (await manager.query(
        `SELECT l.id, l.email, l.sign_order, d.format_key, d.number, d.created_by, s.role,
                nullif(trim(concat_ws(' ', p.first_name, p.last_name)), '') AS signer_name
         FROM signature_signing_link l
         JOIN document d ON d.id = l.document_id
         JOIN person p ON p.id = l.person_id
         LEFT JOIN document_signature s ON s.document_id = l.document_id AND s.sign_order = l.sign_order
         WHERE l.id = $1 AND l.consumed_at IS NULL AND l.invalidated_at IS NULL
           AND (l.delivery_status = 'PENDING_SEND' OR (l.delivery_status = 'FAILED' AND l.send_attempts < $2))
           AND (l.send_started_at IS NULL OR l.send_started_at < NOW() - make_interval(mins => $3))
         FOR UPDATE OF l SKIP LOCKED`,
        [id, MAX_LINK_SEND_ATTEMPTS, LINK_SEND_RETRY_MINUTES],
      )) as Array<{
        id: string;
        email: string;
        sign_order: number;
        format_key: string;
        number: string;
        created_by: string | null;
        role: string | null;
        signer_name: string | null;
      }>;
      if (!link) {
        return null;
      }
      const [issued] = (await manager.query(
        `UPDATE signature_signing_link SET token_hash = $2, send_started_at = NOW(), send_attempts = send_attempts + 1,
           expires_at = NOW() + make_interval(hours => $3)
         WHERE id = $1 RETURNING expires_at`,
        [id, tokenHash, SIGNING_LINK_TTL_HOURS],
      )) as Array<{ expires_at: Date }>;
      const [contact] = link.created_by
        ? ((await manager.query(
            `SELECT nullif(trim(concat_ws(' ', p.first_name, p.last_name)), '') AS name, p.email
             FROM app_user u JOIN person p ON p.id = u.person_id WHERE u.id = $1`,
            [link.created_by],
          )) as Array<{ name: string | null; email: string | null }>)
        : [];
      return { link, expiresAt: issued?.expires_at ?? new Date(), contact };
    });
    if (!claimed) {
      return 'SKIPPED';
    }
    const { link, expiresAt, contact } = claimed;
    const format = findFormat(link.format_key);
    let error: string | null = null;
    try {
      const delivered = await this.mail.sendSigningLink(link.email, {
        url: this.signingUrl(token),
        expiresAt: bogotaDateTime(new Date(expiresAt)),
        formatName: format ? `${format.sgcCode ?? format.key} · ${format.name}` : link.format_key,
        number: link.number,
        signerName: link.signer_name ?? '',
        roleLabel: format?.signers.find((spec) => spec.role === link.role)?.label ?? link.role ?? '',
        contact: contact?.name
          ? `${contact.name}${contact.email ? ` (${contact.email})` : ''}`
          : 'la Oficina de Control Interno',
      });
      if (!delivered) {
        error = 'El correo saliente (SMTP) no está configurado o está deshabilitado';
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message.slice(0, 500) : 'Falló el envío del correo';
    }
    await this.dataSource.query(
      `UPDATE signature_signing_link SET delivery_status = $3::text,
         sent_at = CASE WHEN $3::text = 'SENT' THEN NOW() ELSE sent_at END, last_send_error = $4
       WHERE id = $1 AND token_hash = $2`,
      [id, tokenHash, error ? 'FAILED' : 'SENT', error],
    );
    if (error) {
      this.logger.warn(`El enlace de firma ${id} no se envió: ${error}`);
    }
    return error ? 'FAILED' : 'SENT';
  }

  async findByToken(manager: EntityManager, token: string, lock = false): Promise<SigningLinkRow | null> {
    const [row] = (await manager.query(
      `SELECT * FROM signature_signing_link WHERE token_hash = $1${lock ? ' FOR UPDATE' : ''}`,
      [sha256Hex(token)],
    )) as SigningLinkRow[];
    return row ?? null;
  }

  /** Último enlace de cada turno del acta (detalle del documento). */
  async latestByOrder(documentId: string): Promise<Map<number, SigningLinkRow>> {
    const rows = (await this.dataSource.query(
      `SELECT DISTINCT ON (sign_order) * FROM signature_signing_link WHERE document_id = $1
       ORDER BY sign_order, created_at DESC, id DESC`,
      [documentId],
    )) as SigningLinkRow[];
    return new Map(rows.map((row) => [row.sign_order, row]));
  }
}
