import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EntityManager } from 'typeorm';
import type { AppConfig } from '../../../config/configuration.js';
import { MailOutboxService } from '../../../shared/mail/mail-outbox.service.js';
import type { EmailTemplateType } from '../../email-templates/domain/email-template-catalog.js';
import { NotificationsService } from '../../notifications/services/notifications.service.js';
import { maskEmail } from '../domain/inventory-schedule.js';
import type {
  InventoryNoticeRole,
  InventoryScheduleWarningCode,
} from '../dto/inventory-schedule.responses.js';
import { InventoryScopeType } from '../enums/inventory-scope.js';

export const INVENTORY_ENTITY_TYPE = 'INVENTORY';

export type InventoryNoticeKind = 'SCHEDULED' | 'RESCHEDULED' | 'REMINDER' | 'CANCELLED';

const TEMPLATE: Record<InventoryNoticeKind, EmailTemplateType> = {
  SCHEDULED: 'INVENTORY_SCHEDULED',
  RESCHEDULED: 'INVENTORY_RESCHEDULED',
  REMINDER: 'INVENTORY_REMINDER',
  CANCELLED: 'INVENTORY_CANCELLED',
};

/** Lo que el aviso necesita de la toma (entidad o fila cruda). */
export interface NoticeInventory {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly scopeType: InventoryScopeType;
  readonly scopeId: string | null;
  readonly plannedStartDate: string;
  readonly plannedEndDate: string;
  readonly responsibleUserId: string;
}

export interface NoticeExtra {
  readonly reason?: string;
  readonly previousStartDate?: string;
  readonly previousEndDate?: string;
  /** Recordatorio: días que faltan para el inicio (hoy en Bogotá → inicio). */
  readonly daysUntilStart?: number;
}

interface Recipient {
  readonly personId: string;
  readonly name: string;
  readonly role: InventoryNoticeRole;
  /** Solo en memoria para decidir si hay correo; nunca sale en respuestas, logs ni auditoría. */
  readonly hasEmail: boolean;
  readonly emailMasked: string | null;
  /** Usuario activo de la persona; null si no tiene o no está activo. */
  readonly userId: string | null;
}

export interface NoticeRecipientView {
  readonly personId: string;
  readonly name: string;
  readonly role: InventoryNoticeRole;
  readonly emailMasked: string | null;
  readonly hasUser: boolean;
  readonly email: boolean;
  readonly inApp: boolean;
}

export interface NoticeWarning {
  readonly code: InventoryScheduleWarningCode;
  readonly message: string;
}

export interface NoticeAudience {
  readonly scopeLabel: string;
  readonly costCenter: { readonly id: string; readonly code: string; readonly name: string } | null;
  readonly responsibleName: string | null;
  readonly recipients: ReadonlyArray<NoticeRecipientView>;
  readonly warnings: ReadonlyArray<NoticeWarning>;
  /** Internos: a quién se encola correo (personas) y a quién notificación (usuarios). */
  readonly emailPersonIds: ReadonlyArray<string>;
  readonly inAppUserIds: ReadonlyArray<string>;
}

export interface NoticeResult {
  readonly audience: NoticeAudience;
  readonly outboxIds: ReadonlyArray<string>;
}

interface HeadRow {
  person_id: string;
  name: string;
  email: string | null;
  user_id: string | null;
}

/** "19 de octubre de 2026" (fecha calendario, sin corrimiento de zona). */
export const formatDay = (date: string): string => {
  const [year, month, day] = date.slice(0, 10).split('-').map(Number);
  return new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1)),
  );
};

/** hoy / mañana / en N días. */
export const whenText = (days: number): string => (days <= 0 ? 'hoy' : days === 1 ? 'mañana' : `en ${days} días`);

/**
 * A quién avisar de una toma y cómo. Jefes VIGENTES del centro (todos si hay varios; cost_center_head, vigencia al
 * momento del aviso): correo por mail_outbox dirigido a la persona (recipient_person_id: el jefe puede no tener
 * usuario) y notificación en la aplicación si tiene usuario activo. Responsable de la toma: solo notificación en la
 * aplicación. Otros alcances (GLOBAL, ubicación, unidad) no tienen jefe de centro: solo el responsable.
 * Todo dentro de la transacción del hecho (programar, reprogramar, cancelar o marcar el recordatorio enviado).
 */
@Injectable()
export class InventoryNoticesService {
  constructor(
    private readonly outbox: MailOutboxService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async audience(manager: EntityManager, inventory: NoticeInventory): Promise<NoticeAudience> {
    const scope = await this.scope(manager, inventory);
    const heads: Recipient[] =
      inventory.scopeType === InventoryScopeType.CostCenter && inventory.scopeId
        ? ((await manager.query(
            `SELECT DISTINCT ON (p.id) p.id AS person_id, trim(p.first_name || ' ' || p.last_name) AS name,
                    nullif(trim(p.email::text), '') AS email, u.id AS user_id
             FROM cost_center_head h
             JOIN person p ON p.id = h.person_id
             LEFT JOIN app_user u ON u.person_id = p.id AND u.status = 'ACTIVE'
             WHERE h.cost_center_id = $1
               AND h.valid_from <= NOW() AND (h.valid_until IS NULL OR h.valid_until > NOW())
               AND p.is_active
             ORDER BY p.id`,
            [inventory.scopeId],
          )) as HeadRow[]).map((row) => ({
            personId: row.person_id,
            name: row.name,
            role: 'COST_CENTER_HEAD' as const,
            hasEmail: row.email !== null,
            emailMasked: maskEmail(row.email),
            userId: row.user_id,
          }))
        : [];
    const [responsible] = (await manager.query(
      `SELECT p.id AS person_id, trim(p.first_name || ' ' || p.last_name) AS name,
              nullif(trim(p.email::text), '') AS email, CASE WHEN u.status = 'ACTIVE' THEN u.id END AS user_id
       FROM app_user u JOIN person p ON p.id = u.person_id WHERE u.id = $1`,
      [inventory.responsibleUserId],
    )) as HeadRow[];
    const recipients: Recipient[] = [...heads];
    if (responsible && !heads.some((head) => head.personId === responsible.person_id)) {
      recipients.push({
        personId: responsible.person_id,
        name: responsible.name,
        role: 'RESPONSIBLE',
        hasEmail: responsible.email !== null,
        emailMasked: maskEmail(responsible.email),
        userId: responsible.user_id,
      });
    }
    const emailPersonIds = heads.filter((head) => head.hasEmail).map((head) => head.personId);
    const inAppUserIds = [...new Set(recipients.map((item) => item.userId).filter((id): id is string => id !== null))];
    const warnings: NoticeWarning[] = [];
    if (inventory.scopeType !== InventoryScopeType.CostCenter) {
      warnings.push({
        code: 'NO_HEAD_FOR_SCOPE',
        message: `La toma es de ${scope.label}: no hay jefe de centro de costo a quien avisar; solo el responsable recibe la notificación en la aplicación`,
      });
    } else if (emailPersonIds.length === 0) {
      warnings.push({
        code: 'NO_HEAD_WITH_EMAIL',
        message: `El centro ${scope.costCenter?.code ?? ''} no tiene jefe vigente con correo: el aviso y los recordatorios no llegarán por correo a nadie`,
      });
    }
    return {
      scopeLabel: scope.label,
      costCenter: scope.costCenter,
      responsibleName: responsible?.name ?? null,
      recipients: recipients.map((item) => ({
        personId: item.personId,
        name: item.name,
        role: item.role,
        emailMasked: item.emailMasked,
        hasUser: item.userId !== null,
        email: item.role === 'COST_CENTER_HEAD' && item.hasEmail,
        inApp: item.userId !== null,
      })),
      warnings,
      emailPersonIds,
      inAppUserIds,
    };
  }

  /** Encola los correos y crea las notificaciones del aviso, en la transacción de `manager`. */
  async send(
    manager: EntityManager,
    inventory: NoticeInventory,
    kind: InventoryNoticeKind,
    extra: NoticeExtra = {},
  ): Promise<NoticeResult> {
    const audience = await this.audience(manager, inventory);
    const context = this.context(inventory, audience, extra);
    const outboxIds: string[] = [];
    for (const personId of audience.emailPersonIds) {
      outboxIds.push(
        await this.outbox.enqueue(manager, {
          templateType: TEMPLATE[kind],
          recipientPersonId: personId,
          context,
          entityType: INVENTORY_ENTITY_TYPE,
          entityId: inventory.id,
        }),
      );
    }
    const { title, body } = this.inApp(kind, inventory, audience, extra);
    for (const userId of audience.inAppUserIds) {
      await this.notifications.create(manager, {
        recipientUserId: userId,
        type: TEMPLATE[kind],
        title,
        body,
        entityType: INVENTORY_ENTITY_TYPE,
        entityId: inventory.id,
      });
    }
    return { audience, outboxIds };
  }

  private context(inventory: NoticeInventory, audience: NoticeAudience, extra: NoticeExtra): Record<string, string> {
    const context: Record<string, string> = {
      'toma.codigo': inventory.code,
      'toma.nombre': inventory.name,
      'toma.alcance': audience.scopeLabel,
      'toma.inicio': formatDay(inventory.plannedStartDate),
      'toma.fin': formatDay(inventory.plannedEndDate),
      'toma.responsable': audience.responsibleName ?? '',
      'centro.codigo': audience.costCenter?.code ?? '',
      'centro.nombre': audience.costCenter?.name ?? '',
      'app.loginUrl': this.config.getOrThrow('appPublicUrl', { infer: true }),
      'app.name': 'Control Interno UNAC',
    };
    if (extra.reason !== undefined) {
      context['toma.motivo'] = extra.reason;
    }
    if (extra.previousStartDate !== undefined && extra.previousEndDate !== undefined) {
      context['toma.inicioAnterior'] = formatDay(extra.previousStartDate);
      context['toma.finAnterior'] = formatDay(extra.previousEndDate);
    }
    if (extra.daysUntilStart !== undefined) {
      context['recordatorio.cuando'] = whenText(extra.daysUntilStart);
      context['recordatorio.dias'] = String(Math.max(0, extra.daysUntilStart));
    }
    return context;
  }

  private inApp(
    kind: InventoryNoticeKind,
    inventory: NoticeInventory,
    audience: NoticeAudience,
    extra: NoticeExtra,
  ): { title: string; body: string } {
    const dates = `Del ${formatDay(inventory.plannedStartDate)} al ${formatDay(inventory.plannedEndDate)}`;
    switch (kind) {
      case 'SCHEDULED':
        return { title: `Toma física programada: ${inventory.code}`, body: `${inventory.name}\n${audience.scopeLabel}\n${dates}` };
      case 'RESCHEDULED':
        return {
          title: `Toma física reprogramada: ${inventory.code}`,
          body: `${inventory.name}\n${audience.scopeLabel}\nNuevas fechas: ${dates.toLowerCase()}\nMotivo: ${extra.reason ?? ''}`,
        };
      case 'REMINDER':
        return {
          title: `Recordatorio: la toma ${inventory.code} empieza ${whenText(extra.daysUntilStart ?? 0)}`,
          body: `${inventory.name}\n${audience.scopeLabel}\n${dates}`,
        };
      case 'CANCELLED':
        return {
          title: `Toma física cancelada: ${inventory.code}`,
          body: `${inventory.name}\n${audience.scopeLabel}\nMotivo: ${extra.reason ?? ''}`,
        };
    }
  }

  private async scope(
    manager: EntityManager,
    inventory: NoticeInventory,
  ): Promise<{ label: string; costCenter: NoticeAudience['costCenter'] }> {
    if (inventory.scopeType === InventoryScopeType.Global || !inventory.scopeId) {
      return { label: 'toda la institución', costCenter: null };
    }
    if (inventory.scopeType === InventoryScopeType.CostCenter) {
      const [center] = (await manager.query('SELECT id, external_code AS code, name FROM cost_center WHERE id = $1', [
        inventory.scopeId,
      ])) as Array<{ id: string; code: string; name: string }>;
      return center
        ? { label: `Centro de costo ${center.code} · ${center.name}`, costCenter: center }
        : { label: 'Centro de costo', costCenter: null };
    }
    const table = inventory.scopeType === InventoryScopeType.Location ? 'location' : 'organizational_unit';
    const [target] = (await manager.query(`SELECT code, name FROM ${table} WHERE id = $1`, [inventory.scopeId])) as Array<{
      code: string;
      name: string;
    }>;
    const prefix = inventory.scopeType === InventoryScopeType.Location ? 'Ubicación' : 'Unidad';
    return { label: target ? `${prefix} ${target.code} · ${target.name}` : prefix, costCenter: null };
  }
}
