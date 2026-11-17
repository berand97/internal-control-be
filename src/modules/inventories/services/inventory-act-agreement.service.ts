import { createHash, randomBytes } from 'node:crypto';
import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import type { AppConfig } from '../../../config/configuration.js';
import { MailOutboxService } from '../../../shared/mail/mail-outbox.service.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import { PermissionsService } from '../../roles/services/permissions.service.js';
import type { RespondAgreementDto } from '../dto/inventory-agreement.dto.js';
import { InventoryActAgreementLink } from '../entities/inventory-act-agreement-link.entity.js';
import { PhysicalInventoryAct } from '../entities/physical-inventory-act.entity.js';
import {
  PhysicalInventoryActAgreement,
  type AgreementStatus,
} from '../entities/physical-inventory-act-agreement.entity.js';
import { PhysicalInventory } from '../entities/physical-inventory.entity.js';
import { PhysicalInventoryItem } from '../entities/physical-inventory-item.entity.js';
import { InventoryStatus } from '../enums/inventory-status.js';
import { VerificationResult } from '../enums/verification-result.js';
import { InventoryActService } from './inventory-act.service.js';
import { InventoryCatalogsService } from './inventory-catalogs.service.js';
import { InventoryLocationCompanionService } from './inventory-location-companion.service.js';
import { InventoryValuationService } from './inventory-valuation.service.js';

const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');
const newSecret = (): string => randomBytes(32).toString('base64url');

@Injectable()
export class InventoryActAgreementService {
  constructor(
    @InjectRepository(PhysicalInventoryActAgreement)
    private readonly agreements: Repository<PhysicalInventoryActAgreement>,
    @InjectRepository(InventoryActAgreementLink)
    private readonly links: Repository<InventoryActAgreementLink>,
    @InjectRepository(PhysicalInventoryAct)
    private readonly acts: Repository<PhysicalInventoryAct>,
    @InjectRepository(PhysicalInventory)
    private readonly inventories: Repository<PhysicalInventory>,
    private readonly dataSource: DataSource,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly outbox: MailOutboxService,
    private readonly companions: InventoryLocationCompanionService,
    private readonly valuation: InventoryValuationService,
    private readonly catalogs: InventoryCatalogsService,
    @Inject(forwardRef(() => InventoryActService))
    private readonly actService: InventoryActService,
    private readonly permissions: PermissionsService,
    @Inject('AuditLogsRepository')
    private readonly auditLogs: AuditLogsRepository,
  ) {}

  get linkTtlDays(): number {
    return this.config.getOrThrow('inventories', { infer: true }).agreementLinkTtlDays;
  }

  agreementUrl(token: string): string {
    return `${this.config.getOrThrow('appPublicUrl', { infer: true }).replace(/\/+$/, '')}/conformidad/${token}`;
  }

  async seedAfterClose(manager: EntityManager, inventory: PhysicalInventory, actorId: string): Promise<void> {
    const acts = await manager.getRepository(PhysicalInventoryAct).find({ where: { inventoryId: inventory.id } });
    for (const act of acts) {
      if (!act.signerHeadPersonId || !act.costCenterId || act.documentRequestId) {
        continue;
      }
      const existing = await manager.getRepository(PhysicalInventoryActAgreement).findOne({
        where: { actId: act.id },
      });
      if (existing) {
        continue;
      }
      const summary = await this.buildSummary(manager, inventory, act.costCenterId);
      const agreement = await manager.getRepository(PhysicalInventoryActAgreement).save(
        manager.getRepository(PhysicalInventoryActAgreement).create({
          actId: act.id,
          status: 'PENDING',
          headPersonId: act.signerHeadPersonId,
          comment: null,
          respondedAt: null,
          summarySnapshot: summary as unknown as Record<string, unknown>,
          issuedWithObjection: false,
          issueObjectionReason: null,
        }),
      );
      await this.createAndQueueLink(manager, inventory, act, agreement, actorId, 'REQUEST');
    }
  }

  async getForCenter(inventoryId: string, costCenterId: string) {
    const { inventory, act, agreement } = await this.requireAgreement(inventoryId, costCenterId);
    return this.toResponse(inventory, act, agreement);
  }

  async respondAuthenticated(
    inventoryId: string,
    costCenterId: string,
    dto: RespondAgreementDto,
    actor: AuthenticatedUser,
  ) {
    const { inventory, act, agreement } = await this.requireAgreement(inventoryId, costCenterId);
    if (actor.personId !== agreement.headPersonId) {
      throw new ApiException(ErrorCode.InsufficientPermissions, 'Solo el jefe firmante del acta puede responder.');
    }
    return this.applyDecision(inventory, act, agreement, dto, actor.id, null);
  }

  async respondByToken(token: string, dto: RespondAgreementDto) {
    const link = await this.findActiveLink(token);
    const agreement = await this.agreements.findOne({ where: { id: link.agreementId } });
    if (!agreement) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    const act = await this.acts.findOne({ where: { id: agreement.actId } });
    if (!act) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    const inventory = await this.inventories.findOne({ where: { id: act.inventoryId } });
    if (!inventory) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return this.applyDecision(inventory, act, agreement, dto, null, link.id);
  }

  async viewByToken(token: string) {
    const link = await this.findActiveLink(token);
    const agreement = await this.agreements.findOneOrFail({ where: { id: link.agreementId } });
    const act = await this.acts.findOneOrFail({ where: { id: agreement.actId } });
    const inventory = await this.inventories.findOneOrFail({ where: { id: act.inventoryId } });
    return this.toResponse(inventory, act, agreement);
  }

  async resend(inventoryId: string, costCenterId: string, actor: AuthenticatedUser) {
    if (!(await this.permissions.userHasPermission(actor.id, 'inventory:create:global'))) {
      throw new ApiException(ErrorCode.InsufficientPermissions);
    }
    const { inventory, act, agreement } = await this.requireAgreement(inventoryId, costCenterId);
    if (agreement.status !== 'PENDING') {
      throw new ApiException(
        ErrorCode.InvalidState,
        'Solo se reenvía con conformidad pendiente. Si ya respondió, use reabrir.',
      );
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `UPDATE inventory_act_agreement_link SET invalidated_at = NOW()
         WHERE agreement_id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL`,
        [agreement.id],
      );
      await this.createAndQueueLink(manager, inventory, act, agreement, actor.id, 'RESEND');
      await this.auditLogs.record(
        {
          action: AuditAction.InventoryAgreementReopened,
          entityType: 'INVENTORY',
          entityId: inventory.id,
          performedBy: actor.id,
          ipAddress: null,
          userAgent: null,
          changes: { actId: act.id, costCenterId: act.costCenterId, resend: true },
        },
        manager,
      );
    });
    return this.getForCenter(inventoryId, costCenterId);
  }

  async reopen(inventoryId: string, costCenterId: string, actor: AuthenticatedUser) {
    if (!(await this.permissions.userHasPermission(actor.id, 'inventory:create:global'))) {
      throw new ApiException(ErrorCode.InsufficientPermissions);
    }
    const { inventory, act, agreement } = await this.requireAgreement(inventoryId, costCenterId);
    if (agreement.status === 'PENDING') {
      throw new ApiException(ErrorCode.InvalidState, 'La conformidad ya está pendiente. Use reenviar.');
    }
    if (act.documentRequestId) {
      throw new ApiException(ErrorCode.InvalidState, 'El acta ya se emitió.');
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO physical_inventory_act_agreement_history
           (agreement_id, status, comment, responded_at, summary_snapshot, archived_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          agreement.id,
          agreement.status,
          agreement.comment,
          agreement.respondedAt,
          JSON.stringify(agreement.summarySnapshot),
          actor.id,
        ],
      );
      agreement.status = 'PENDING';
      agreement.comment = null;
      agreement.respondedAt = null;
      agreement.summarySnapshot = (await this.buildSummary(
        manager,
        inventory,
        act.costCenterId as string,
      )) as unknown as Record<string, unknown>;
      agreement.updatedAt = new Date();
      await manager.getRepository(PhysicalInventoryActAgreement).save(agreement);
      await manager.query(
        `UPDATE inventory_act_agreement_link SET invalidated_at = NOW()
         WHERE agreement_id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL`,
        [agreement.id],
      );
      await this.createAndQueueLink(manager, inventory, act, agreement, actor.id, 'REOPEN');
      await this.auditLogs.record(
        {
          action: AuditAction.InventoryAgreementReopened,
          entityType: 'INVENTORY',
          entityId: inventory.id,
          performedBy: actor.id,
          ipAddress: null,
          userAgent: null,
          changes: { actId: act.id, costCenterId: act.costCenterId },
        },
        manager,
      );
    });
    return this.getForCenter(inventoryId, costCenterId);
  }

  async issueObjected(
    inventoryId: string,
    costCenterId: string,
    reason: string,
    actor: AuthenticatedUser,
  ) {
    if (!(await this.permissions.userHasPermission(actor.id, 'inventory:create:global'))) {
      throw new ApiException(ErrorCode.InsufficientPermissions);
    }
    if (reason.trim().length < 20) {
      throw new ApiException(ErrorCode.ValidationFailed, 'Indique el motivo (mínimo 20 caracteres).');
    }
    const { inventory, act, agreement } = await this.requireAgreement(inventoryId, costCenterId);
    if (agreement.status !== 'OBJECTED') {
      throw new ApiException(ErrorCode.InvalidState, 'Solo aplica cuando el jefe objetó.');
    }
    if (act.documentRequestId) {
      throw new ApiException(ErrorCode.InvalidState, 'El acta ya se emitió.');
    }
    agreement.issuedWithObjection = true;
    agreement.issueObjectionReason = reason.trim();
    agreement.updatedAt = new Date();
    await this.agreements.save(agreement);
    await this.auditLogs.record({
      action: AuditAction.InventoryActIssuedObjected,
      entityType: 'INVENTORY',
      entityId: inventory.id,
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
      changes: { actId: act.id, costCenterId, reason: reason.trim(), comment: agreement.comment },
    });
    return this.actService.retryEnqueue(inventoryId, costCenterId, actor);
  }

  async statusByActIds(actIds: string[]): Promise<Map<string, { status: AgreementStatus; respondedAt: Date | null }>> {
    if (actIds.length === 0) {
      return new Map();
    }
    const rows = await this.agreements
      .createQueryBuilder('a')
      .where('a.act_id IN (:...ids)', { ids: actIds })
      .getMany();
    return new Map(rows.map((row) => [row.actId, { status: row.status, respondedAt: row.respondedAt }]));
  }

  async statusByCostCenters(
    inventoryId: string,
  ): Promise<Map<string, { status: AgreementStatus; respondedAt: Date | null }>> {
    const rows = (await this.dataSource.query(
      `SELECT act.cost_center_id, a.status, a.responded_at
       FROM physical_inventory_act_agreement a
       JOIN physical_inventory_act act ON act.id = a.act_id
       WHERE act.inventory_id = $1 AND act.cost_center_id IS NOT NULL`,
      [inventoryId],
    )) as Array<{ cost_center_id: string; status: AgreementStatus; responded_at: Date | null }>;
    return new Map(rows.map((row) => [row.cost_center_id, { status: row.status, respondedAt: row.responded_at }]));
  }

  async assertCanEnqueue(act: PhysicalInventoryAct): Promise<{ ok: true } | { blocked: string; message: string }> {
    if (!act.signerHeadPersonId) {
      return { ok: true };
    }
    const agreement = await this.agreements.findOne({ where: { actId: act.id } });
    if (!agreement) {
      return {
        blocked: 'AGREEMENT_PENDING',
        message: 'Falta la conformidad del jefe del centro antes de emitir el acta.',
      };
    }
    if (agreement.status === 'AGREED') {
      return { ok: true };
    }
    if (agreement.status === 'OBJECTED' && agreement.issuedWithObjection) {
      return { ok: true };
    }
    if (agreement.status === 'OBJECTED') {
      return {
        blocked: 'AGREEMENT_OBJECTED',
        message: agreement.comment?.trim() || 'El jefe objetó la conformidad del acta.',
      };
    }
    return {
      blocked: 'AGREEMENT_PENDING',
      message: 'El jefe aún no respondió la conformidad del acta.',
    };
  }

  async objectionComment(actId: string): Promise<string | null> {
    const agreement = await this.agreements.findOne({ where: { actId } });
    if (!agreement) {
      return null;
    }
    if (agreement.issuedWithObjection || agreement.status === 'OBJECTED') {
      return agreement.comment;
    }
    return null;
  }

  async processReminders(): Promise<number> {
    const now = new Date();
    const day = 24 * 60 * 60 * 1000;
    const rows = (await this.dataSource.query(
      `SELECT l.id, l.agreement_id, l.created_at, l.reminder_day3_at, l.reminder_day6_at,
              a.head_person_id, act.inventory_id, pi.code, pi.name
       FROM inventory_act_agreement_link l
       JOIN physical_inventory_act_agreement a ON a.id = l.agreement_id
       JOIN physical_inventory_act act ON act.id = a.act_id
       JOIN physical_inventory pi ON pi.id = act.inventory_id
       WHERE a.status = 'PENDING'
         AND l.consumed_at IS NULL AND l.invalidated_at IS NULL
         AND l.token_hash IS NOT NULL
         AND (l.expires_at IS NULL OR l.expires_at > NOW())`,
    )) as Array<{
      id: string;
      agreement_id: string;
      created_at: Date;
      reminder_day3_at: Date | null;
      reminder_day6_at: Date | null;
      head_person_id: string;
      code: string;
      name: string;
    }>;
    let sent = 0;
    for (const row of rows) {
      const ageMs = now.getTime() - new Date(row.created_at).getTime();
      const need3 = !row.reminder_day3_at && ageMs >= 3 * day;
      const need6 = !row.reminder_day6_at && ageMs >= 6 * day;
      if (!need3 && !need6) {
        continue;
      }
      const [person] = (await this.dataSource.query(
        `SELECT nullif(trim(email::text), '') AS email FROM person WHERE id = $1`,
        [row.head_person_id],
      )) as Array<{ email: string | null }>;
      if (!person?.email) {
        continue;
      }
      const token = newSecret();
      await this.dataSource.transaction(async (manager) => {
        await manager.query(
          `UPDATE inventory_act_agreement_link
           SET token_hash = $2, expires_at = $3,
               reminder_day3_at = CASE WHEN $4 THEN NOW() ELSE reminder_day3_at END,
               reminder_day6_at = CASE WHEN $5 THEN NOW() ELSE reminder_day6_at END
           WHERE id = $1`,
          [row.id, sha256Hex(token), new Date(now.getTime() + this.linkTtlDays * day), need3, need6],
        );
        await this.outbox.enqueue(manager, {
          templateType: 'INVENTORY_ALERT',
          recipientPersonId: row.head_person_id,
          context: {
            'user.email': person.email as string,
            'inventario.nombre': `${row.code} — ${row.name}`,
            'alerta.mensaje': `Recordatorio: responda la conformidad del acta. ${this.agreementUrl(token)}`,
            'inventario.fecha': '',
            'app.loginUrl': this.agreementUrl(token),
          },
          entityType: 'INVENTORY_AGREEMENT',
          entityId: row.agreement_id,
        });
      });
      sent += 1;
    }
    return sent;
  }

  private async applyDecision(
    inventory: PhysicalInventory,
    act: PhysicalInventoryAct,
    agreement: PhysicalInventoryActAgreement,
    dto: RespondAgreementDto,
    actorUserId: string | null,
    linkId: string | null,
  ) {
    if (inventory.status !== InventoryStatus.Closed && inventory.status !== InventoryStatus.Reconciled) {
      throw new ApiException(ErrorCode.InvalidState, 'La conformidad aplica con la toma cerrada.');
    }
    if (agreement.status !== 'PENDING') {
      throw new ApiException(ErrorCode.InvalidState, 'Esta conformidad ya fue respondida.');
    }
    if (dto.decision === 'OBJECTED' && !dto.comment?.trim()) {
      throw new ApiException(ErrorCode.ValidationFailed, 'La objeción requiere un comentario.', [
        { field: 'comment', message: 'Escriba la observación.' },
      ]);
    }
    const now = new Date();
    await this.dataSource.transaction(async (manager) => {
      agreement.status = dto.decision;
      agreement.comment = dto.decision === 'OBJECTED' ? (dto.comment?.trim() ?? null) : null;
      agreement.respondedAt = now;
      agreement.updatedAt = now;
      await manager.getRepository(PhysicalInventoryActAgreement).save(agreement);
      if (linkId) {
        await manager.query(`UPDATE inventory_act_agreement_link SET consumed_at = NOW() WHERE id = $1`, [linkId]);
      } else {
        await manager.query(
          `UPDATE inventory_act_agreement_link SET consumed_at = NOW()
           WHERE agreement_id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL`,
          [agreement.id],
        );
      }
      await this.auditLogs.record(
        {
          action: AuditAction.InventoryAgreementResponded,
          entityType: 'INVENTORY',
          entityId: inventory.id,
          performedBy: actorUserId,
          ipAddress: null,
          userAgent: null,
          changes: {
            actId: act.id,
            costCenterId: act.costCenterId,
            decision: dto.decision,
            comment: agreement.comment,
          },
        },
        manager,
      );
      await this.notifyControlInterno(manager, inventory, agreement);
    });
    if (dto.decision === 'AGREED') {
      const approverId = actorUserId ?? inventory.reconcileApprovedBy ?? inventory.closedBy;
      if (approverId) {
        try {
          await this.actService.retryEnqueue(inventory.id, act.costCenterId, {
            id: approverId,
            personId: agreement.headPersonId,
            username: '',
            roles: [],
            scopes: [],
          } as AuthenticatedUser);
        } catch {}
      }
    }
    return this.toResponse(inventory, act, agreement);
  }

  private async notifyControlInterno(
    manager: EntityManager,
    inventory: PhysicalInventory,
    agreement: PhysicalInventoryActAgreement,
  ) {
    const [resp] = (await manager.query(
      `SELECT u.id AS user_id, nullif(trim(p.email::text), '') AS email
       FROM app_user u JOIN person p ON p.id = u.person_id
       WHERE u.id = $1 AND u.status = 'ACTIVE'`,
      [inventory.responsibleUserId],
    )) as Array<{ user_id: string; email: string | null }>;
    if (!resp?.email) {
      return;
    }
    const msg =
      agreement.status === 'AGREED'
        ? `El jefe acordó la conformidad del acta. Ya puede emitirse (${inventory.code}).`
        : `El jefe objetó la conformidad del acta (${inventory.code}): ${agreement.comment ?? ''}`;
    await this.outbox.enqueue(manager, {
      templateType: 'INVENTORY_ALERT',
      recipientUserId: resp.user_id,
      context: {
        'user.email': resp.email,
        'inventario.nombre': inventory.name,
        'alerta.mensaje': msg.slice(0, 2000),
        'inventario.fecha': '',
        'app.loginUrl': this.config.getOrThrow('appPublicUrl', { infer: true }),
      },
      entityType: 'INVENTORY_AGREEMENT',
      entityId: agreement.id,
    });
  }

  private async createAndQueueLink(
    manager: EntityManager,
    inventory: PhysicalInventory,
    act: PhysicalInventoryAct,
    agreement: PhysicalInventoryActAgreement,
    _actorId: string,
    kind: 'REQUEST' | 'REOPEN' | 'RESEND',
  ) {
    const token = newSecret();
    const expires = new Date(Date.now() + this.linkTtlDays * 24 * 60 * 60 * 1000);
    await manager.getRepository(InventoryActAgreementLink).save(
      manager.getRepository(InventoryActAgreementLink).create({
        agreementId: agreement.id,
        tokenHash: sha256Hex(token),
        expiresAt: expires,
        consumedAt: null,
        deliveryStatus: 'PENDING_SEND',
        sendAttempts: 0,
        sentAt: null,
        lastSendError: null,
        reminderDay3At: null,
        reminderDay6At: null,
        invalidatedAt: null,
      }),
    );
    const [person] = (await manager.query(
      `SELECT nullif(trim(email::text), '') AS email FROM person WHERE id = $1`,
      [agreement.headPersonId],
    )) as Array<{ email: string | null }>;
    if (!person?.email) {
      return;
    }
    const [center] = (await manager.query(
      `SELECT external_code AS code, name FROM cost_center WHERE id = $1`,
      [act.costCenterId],
    )) as Array<{ code: string; name: string }>;
    const url = this.agreementUrl(token);
    const message =
      kind === 'REOPEN'
        ? `Se reabrió la conformidad del acta. Revise y responda: ${url}`
        : kind === 'RESEND'
          ? `Reenvío: dé su conformidad del acta de la toma ${inventory.code}: ${url}`
          : `La toma ${inventory.code} está cerrada. Dé su conformidad: ${url}`;
    await this.outbox.enqueue(manager, {
      templateType: 'INVENTORY_ALERT',
      recipientPersonId: agreement.headPersonId,
      context: {
        'user.email': person.email,
        'inventario.nombre': `${inventory.code} — ${center?.code ?? ''} ${center?.name ?? ''}`,
        'alerta.mensaje': message,
        'inventario.fecha': expires.toISOString().slice(0, 10),
        'app.loginUrl': url,
      },
      entityType: 'INVENTORY_AGREEMENT',
      entityId: agreement.id,
    });
  }

  private async findActiveLink(token: string): Promise<InventoryActAgreementLink> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    const link = await this.links.findOne({ where: { tokenHash: sha256Hex(token) } });
    if (!link || link.consumedAt || link.invalidatedAt) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    if (link.expiresAt && link.expiresAt <= new Date()) {
      throw new ApiException(ErrorCode.InvalidState, 'El enlace de conformidad venció.');
    }
    return link;
  }

  private async requireAgreement(inventoryId: string, costCenterId: string) {
    const inventory = await this.inventories.findOne({ where: { id: inventoryId } });
    if (!inventory) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    const act = await this.acts.findOne({ where: { inventoryId, costCenterId } });
    if (!act) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    const agreement = await this.agreements.findOne({ where: { actId: act.id } });
    if (!agreement) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'Aún no hay conformidad para este centro.');
    }
    return { inventory, act, agreement };
  }

  private async buildSummary(manager: EntityManager, inventory: PhysicalInventory, costCenterId: string) {
    const items = await manager.getRepository(PhysicalInventoryItem).find({
      where: { inventoryId: inventory.id },
    });
    const centerItems = items.filter(
      (item) =>
        !item.voidedAt &&
        (item.expectedCostCenterId === costCenterId ||
          (item.verificationResult === VerificationResult.Surplus && item.surplusCostCenterId === costCenterId)),
    );
    const basis = await this.valuation.basis(inventory, manager);
    const valuations = await this.valuation.valuations(
      inventory,
      centerItems.flatMap((item) => [item.assetId, item.resolvedAssetId]).filter((id): id is string => !!id),
      manager,
      basis,
    );
    const catalogs = await this.catalogs.viewContext();
    const assetRows = (await manager.query(
      `SELECT id,
              coalesce(nullif(barcode, ''), nullif(serial_number, ''), internal_code) AS code,
              description
       FROM asset WHERE id = ANY($1::uuid[])`,
      [centerItems.map((item) => item.assetId).filter((id): id is string => !!id)],
    )) as Array<{ id: string; code: string; description: string }>;
    const assets = new Map(assetRows.map((row) => [row.id, row]));
    const missing = centerItems
      .filter((item) => item.verificationResult === VerificationResult.Missing)
      .map((item) => {
        const asset = item.assetId ? assets.get(item.assetId) : null;
        const book = item.assetId ? (valuations.get(item.assetId)?.bookValue ?? null) : null;
        const cause =
          (item.missingCauseId ? catalogs.causeLabels.get(item.missingCauseId) : null) ??
          item.missingCauseOther ??
          null;
        return {
          assetCode: asset?.code ?? '',
          description: asset?.description ?? '',
          bookValue: book,
          cause,
        };
      });
    const surplus = centerItems
      .filter((item) => item.verificationResult === VerificationResult.Surplus)
      .map((item) => ({
        description:
          item.notes?.trim() || (item.assetId ? (assets.get(item.assetId)?.description ?? 'Sobrante') : 'Sobrante'),
        resolution: item.surplusResolution,
      }));
    const companions = await this.companions.companionsForCenter(inventory.id, costCenterId);
    return {
      expected: centerItems.filter((item) => item.verificationResult !== VerificationResult.Surplus).length,
      found: centerItems.filter((item) => item.verificationResult === VerificationResult.Found).length,
      misplaced: centerItems.filter((item) => item.verificationResult === VerificationResult.Misplaced).length,
      missing,
      surplus,
      bookValueAtRisk: missing.reduce((sum, row) => sum + (row.bookValue ?? 0), 0),
      companions: companions.map((row) => row.name),
    };
  }

  private async toResponse(
    inventory: PhysicalInventory,
    act: PhysicalInventoryAct,
    agreement: PhysicalInventoryActAgreement,
  ) {
    const [center] = (await this.dataSource.query(
      `SELECT id, external_code AS code, name FROM cost_center WHERE id = $1`,
      [act.costCenterId],
    )) as Array<{ id: string; code: string; name: string }>;
    const snap = agreement.summarySnapshot as {
      expected?: number;
      found?: number;
      misplaced?: number;
      missing?: unknown[];
      surplus?: unknown[];
      bookValueAtRisk?: number;
      companions?: string[];
    };
    const companions =
      snap.companions ??
      (await this.companions.companionsForCenter(inventory.id, act.costCenterId as string)).map((row) => row.name);
    return {
      status: agreement.status,
      costCenter: center ?? { id: act.costCenterId as string, code: '', name: '' },
      summary: {
        expected: snap.expected ?? 0,
        found: snap.found ?? 0,
        misplaced: snap.misplaced ?? 0,
        missing: (snap.missing ?? []) as never[],
        surplus: (snap.surplus ?? []) as never[],
        bookValueAtRisk: snap.bookValueAtRisk ?? 0,
      },
      companions,
      respondedAt: agreement.respondedAt?.toISOString() ?? null,
      comment: agreement.comment,
    };
  }
}
