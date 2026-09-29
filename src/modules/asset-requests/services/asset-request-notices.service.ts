import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EntityManager } from 'typeorm';
import type { AppConfig } from '../../../config/configuration.js';
import { MailOutboxService } from '../../../shared/mail/mail-outbox.service.js';
import type { EmailTemplateType } from '../../email-templates/domain/email-template-catalog.js';
import { NotificationsService } from '../../notifications/services/notifications.service.js';
import {
  ASSET_REQUEST_ENTITY_TYPE,
  ASSET_REQUEST_KIND_LABELS,
  ASSET_REQUEST_REVIEW,
  type AssetRequestKind,
} from '../domain/asset-request.js';

export type AssetRequestNoticeKind =
  | 'CREATED'
  | 'ACCEPTED'
  | 'CLOSED'
  | 'RETURNED'
  | 'CORRECTED'
  | 'CANCELLED'
  | 'GENERATED'
  | 'SCHEDULED'
  | 'LOAN_STARTS'
  | 'EXPIRED'
  | 'COMPLETED';

/** A quién va cada aviso: el solicitante, los jefes vigentes del centro dueño y Control Interno (revisores). */
export type AssetRequestAudience = 'REQUESTER' | 'OWNER_HEADS' | 'REVIEWERS';

export interface AssetRequestNoticeExtra {
  readonly reason?: string;
  /** Corrección: a quién pasa (centro dueño o Control Interno). */
  readonly nextReviewer?: string;
  readonly expiredOn?: string;
  /** Vencimiento de una solicitud devuelta: el motivo con que Control Interno la devolvió. */
  readonly returnReason?: string;
  /** Préstamo programado: fecha de inicio (desde la que se entrega), en texto largo. */
  readonly startDate?: string;
  readonly assetCount?: number;
  readonly document?: { readonly kind: string; readonly number?: string; readonly documentId?: string };
}

interface NoticeRequestRow {
  id: string;
  code: string;
  kind: AssetRequestKind;
  description: string;
  requester_user_id: string;
  requester_person_id: string;
  requester_name: string;
  owner_cost_center_id: string;
  requesting_label: string;
  owner_label: string;
}

interface RecipientRow {
  person_id: string | null;
  user_id: string | null;
  has_email: boolean;
}

const TEMPLATE: Record<AssetRequestNoticeKind, EmailTemplateType> = {
  CREATED: 'ASSET_REQUEST_CREATED',
  ACCEPTED: 'ASSET_REQUEST_ACCEPTED',
  CLOSED: 'ASSET_REQUEST_CLOSED',
  RETURNED: 'ASSET_REQUEST_RETURNED',
  CORRECTED: 'ASSET_REQUEST_CORRECTED',
  CANCELLED: 'ASSET_REQUEST_CANCELLED',
  GENERATED: 'ASSET_REQUEST_GENERATED',
  SCHEDULED: 'ASSET_REQUEST_LOAN_SCHEDULED',
  LOAN_STARTS: 'ASSET_REQUEST_LOAN_STARTS',
  EXPIRED: 'ASSET_REQUEST_EXPIRED',
  COMPLETED: 'ASSET_REQUEST_COMPLETED',
};

const TITLE: Record<AssetRequestNoticeKind, string> = {
  CREATED: 'Nueva solicitud de activos',
  ACCEPTED: 'Solicitud de activos aceptada',
  CLOSED: 'Solicitud de activos cerrada por el centro dueño',
  RETURNED: 'Solicitud de activos devuelta para corregir',
  CORRECTED: 'Solicitud de activos corregida',
  CANCELLED: 'Solicitud de activos cancelada',
  GENERATED: 'Documento de la solicitud generado',
  SCHEDULED: 'Préstamo de la solicitud programado',
  LOAN_STARTS: 'Hoy se entrega el préstamo de la solicitud',
  EXPIRED: 'Solicitud de activos vencida',
  COMPLETED: 'Acta de la solicitud firmada',
};

/**
 * Avisos de la solicitud de activos: notificación en la aplicación (usuarios activos) y correo por mail_outbox
 * (personas con correo), ambos en la transacción del hecho. Un mismo destinatario recibe un solo aviso aunque tenga
 * dos papeles. Sin segundo mecanismo: mismos servicios que los avisos de tomas físicas.
 */
@Injectable()
export class AssetRequestNoticesService {
  constructor(
    private readonly outbox: MailOutboxService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async send(
    manager: EntityManager,
    requestId: string,
    kind: AssetRequestNoticeKind,
    audience: ReadonlyArray<AssetRequestAudience>,
    extra: AssetRequestNoticeExtra = {},
  ): Promise<void> {
    const [request] = (await manager.query(
      `SELECT r.id, r.code, r.kind, r.description, r.requester_user_id, r.requester_person_id, r.owner_cost_center_id,
              trim(p.first_name || ' ' || p.last_name) AS requester_name,
              rc.external_code || ' · ' || rc.name AS requesting_label, oc.external_code || ' · ' || oc.name AS owner_label
       FROM asset_request r
       JOIN person p ON p.id = r.requester_person_id
       JOIN cost_center rc ON rc.id = r.requesting_cost_center_id
       JOIN cost_center oc ON oc.id = r.owner_cost_center_id
       WHERE r.id = $1`,
      [requestId],
    )) as NoticeRequestRow[];
    if (!request) {
      return;
    }
    const recipients = await this.recipients(manager, request, audience);
    const context = this.context(request, extra);
    const templateType = TEMPLATE[kind];
    for (const recipient of recipients) {
      if (recipient.person_id && recipient.has_email) {
        await this.outbox.enqueue(manager, {
          templateType,
          recipientPersonId: recipient.person_id,
          context,
          entityType: ASSET_REQUEST_ENTITY_TYPE,
          entityId: request.id,
        });
      }
      if (recipient.user_id) {
        await this.notifications.create(manager, {
          recipientUserId: recipient.user_id,
          type: templateType,
          title: `${TITLE[kind]}: ${request.code}`,
          body: this.body(kind, request, extra),
          entityType: ASSET_REQUEST_ENTITY_TYPE,
          entityId: request.id,
        });
      }
    }
  }

  private async recipients(
    manager: EntityManager,
    request: NoticeRequestRow,
    audience: ReadonlyArray<AssetRequestAudience>,
  ): Promise<RecipientRow[]> {
    const rows: RecipientRow[] = [];
    if (audience.includes('REQUESTER')) {
      rows.push(
        ...((await manager.query(
          `SELECT p.id AS person_id, CASE WHEN u.status = 'ACTIVE' THEN u.id END AS user_id,
                  (p.is_active AND nullif(trim(p.email::text), '') IS NOT NULL) AS has_email
           FROM app_user u JOIN person p ON p.id = $2 WHERE u.id = $1`,
          [request.requester_user_id, request.requester_person_id],
        )) as RecipientRow[]),
      );
    }
    if (audience.includes('OWNER_HEADS')) {
      rows.push(
        ...((await manager.query(
          `SELECT DISTINCT ON (p.id) p.id AS person_id, u.id AS user_id,
                  (nullif(trim(p.email::text), '') IS NOT NULL) AS has_email
           FROM cost_center_head h
           JOIN person p ON p.id = h.person_id AND p.is_active
           LEFT JOIN app_user u ON u.person_id = p.id AND u.status = 'ACTIVE'
           WHERE h.cost_center_id = $1 AND h.valid_from <= NOW() AND (h.valid_until IS NULL OR h.valid_until > NOW())
             AND p.id <> $2
           ORDER BY p.id, u.id`,
          [request.owner_cost_center_id, request.requester_person_id],
        )) as RecipientRow[]),
      );
    }
    if (audience.includes('REVIEWERS')) {
      rows.push(
        ...((await manager.query(
          `SELECT DISTINCT p.id AS person_id, u.id AS user_id,
                  (p.is_active AND nullif(trim(p.email::text), '') IS NOT NULL) AS has_email
           FROM v_user_effective_permissions v
           JOIN app_user u ON u.id = v.user_id AND u.status = 'ACTIVE'
           LEFT JOIN person p ON p.id = u.person_id
           WHERE v.permission_code = $1`,
          [ASSET_REQUEST_REVIEW],
        )) as RecipientRow[]),
      );
    }
    const seenPersons = new Set<string>();
    const seenUsers = new Set<string>();
    return rows.map((row) => {
      const person = row.person_id && !seenPersons.has(row.person_id) ? row.person_id : null;
      const user = row.user_id && !seenUsers.has(row.user_id) ? row.user_id : null;
      if (person) {
        seenPersons.add(person);
      }
      if (user) {
        seenUsers.add(user);
      }
      return { person_id: person, user_id: user, has_email: row.has_email };
    });
  }

  private context(request: NoticeRequestRow, extra: AssetRequestNoticeExtra): Record<string, string> {
    const base = this.config.getOrThrow('appPublicUrl', { infer: true }).replace(/\/+$/, '');
    const context: Record<string, string> = {
      'solicitud.codigo': request.code,
      'solicitud.tipo': ASSET_REQUEST_KIND_LABELS[request.kind],
      'solicitud.centroSolicitante': request.requesting_label,
      'solicitud.centroDueno': request.owner_label,
      'solicitud.url': `${base}/asset-requests/${request.id}`,
      'solicitud.descripcion': request.description,
      'solicitud.solicitante': request.requester_name,
      'app.loginUrl': base,
      'app.name': 'Control Interno UNAC',
    };
    if (extra.reason !== undefined) {
      context['solicitud.motivo'] = extra.reason;
    }
    if (extra.nextReviewer !== undefined) {
      context['solicitud.estado'] = extra.nextReviewer;
    }
    if (extra.expiredOn !== undefined) {
      context['solicitud.vencio'] = extra.expiredOn;
    }
    if (extra.startDate !== undefined) {
      context['prestamo.inicio'] = extra.startDate;
    }
    if (extra.assetCount !== undefined) {
      context['solicitud.activos'] = String(extra.assetCount);
    }
    if (extra.document) {
      context['documento.tipo'] = extra.document.kind;
      context['documento.numero'] = extra.document.number ?? '';
      context['documento.url'] = extra.document.documentId
        ? `${base}/documents/${extra.document.documentId}`
        : `${base}/asset-requests/${request.id}`;
    }
    return context;
  }

  private body(kind: AssetRequestNoticeKind, request: NoticeRequestRow, extra: AssetRequestNoticeExtra): string {
    const lines = [
      `${ASSET_REQUEST_KIND_LABELS[request.kind]}: ${request.requesting_label} pide a ${request.owner_label}`,
    ];
    if (kind === 'ACCEPTED' && extra.assetCount !== undefined) {
      lines.push(`Activos elegidos: ${extra.assetCount}`);
    }
    if (extra.reason) {
      lines.push(`Motivo: ${extra.reason}`);
    }
    if (extra.nextReviewer) {
      lines.push(`Ahora la revisa: ${extra.nextReviewer}`);
    }
    if (extra.document) {
      lines.push(`${extra.document.kind}${extra.document.number ? ` N.° ${extra.document.number}` : ''}`);
    }
    if (kind === 'SCHEDULED' && extra.startDate) {
      lines.push(`Préstamo programado: se entrega desde el ${extra.startDate}. Nada se ha entregado todavía`);
    }
    if (kind === 'LOAN_STARTS' && extra.startDate) {
      lines.push(`Hoy (${extra.startDate}) se puede entregar el préstamo: el jefe del centro dueño o Control Interno registran la entrega`);
    }
    if (extra.returnReason !== undefined) {
      lines.push(`Estaba devuelta al solicitante para corregir (motivo: ${extra.returnReason || 'sin motivo registrado'}) y no se corrigió`);
    }
    if (extra.expiredOn) {
      lines.push(`Venció el ${extra.expiredOn}; los activos elegidos quedaron libres`);
    }
    return lines.join('\n');
  }
}
