import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import {
  DocumentLifecycleRegistry,
  type DocumentLifecycleEvent,
} from '../../documents/lifecycle/document-lifecycle.registry.js';
import {
  CONDITION_LABELS,
  DocumentEngineService,
  type DocumentRequestPayload,
} from '../../documents/services/document-engine.service.js';
import {
  type ActItem,
  buildInventoryActContent,
  INVENTORY_ACT_ENTITY_TYPE,
  INVENTORY_ACT_FORMAT_KEY,
  type InventoryActGeneration,
  type InventoryActReason,
  type InventoryActRetryAction,
} from '../domain/inventory-act.js';
import type { SignerSubstitutionsInput } from '../../documents/dto/signer-substitution.dto.js';
import { PhysicalInventory } from '../entities/physical-inventory.entity.js';
import { InventoryScopeType } from '../enums/inventory-scope.js';
import { InventoryStatus } from '../enums/inventory-status.js';
import { VerificationResult } from '../enums/verification-result.js';
import { InventoryCatalogsService } from './inventory-catalogs.service.js';
import { InventoryValuationService } from './inventory-valuation.service.js';

/** Reintentos automáticos del outbox (DocumentEngineService.processPending: attempts < 5). */
const AUTOMATIC_GENERATION_ATTEMPTS = 5;

/** Errores de separación de funciones que el encolado manual devuelve tal cual. */
const SIGNER_ERRORS: ReadonlyArray<ErrorCode> = [
  ErrorCode.DocumentSignerDuplicated,
  ErrorCode.DocumentSignerSubstituteInvalid,
  ErrorCode.DocumentSignerNotEligible,
];

type BlockedReason = Extract<
  InventoryActReason,
  'FORMAT_NOT_READY' | 'ENQUEUE_FAILED'
>;

type EnqueueOutcome =
  | { readonly requestId: string }
  | { readonly blocked: BlockedReason; readonly message: string };

const TEMPLATE_NOT_ACTIVE_MESSAGE =
  `El formato ${INVENTORY_ACT_FORMAT_KEY} no tiene plantilla vigente: Control Interno debe cargarla en ` +
  'Administración de formatos. El acta se genera al reintentar.';

interface ActItemRow {
  id: string;
  asset_id: string | null;
  verification_result: VerificationResult;
  actual_condition: ActItem['actualCondition'];
  expected_code_temporary: boolean | null;
  finding_category_code: string | null;
  missing_cause_id: string | null;
  missing_cause_other: string | null;
  notes: string | null;
  voided: boolean;
  location_name: string | null;
  resolved_asset_id: string | null;
  resolved_asset_code: string | null;
  surplus_resolution: string | null;
  surplus_resolution_reason: string | null;
}

/**
 * Acta de toma física OCI-21-37. Al aprobar la conciliación se encola en la misma transacción; si el formato no está
 * listo o falla armarla, la conciliación sigue y el motivo queda en la toma (act_blocked_*), reintentable con
 * POST /inventories/:id/act/enqueue. La generación es asíncrona (outbox). Los manejadores del ciclo de vida solo
 * guardan el vínculo con el acta: firmarla o rechazarla no cambia la toma.
 */
@Injectable()
export class InventoryActService implements OnModuleInit {
  constructor(
    private readonly dataSource: DataSource,
    private readonly engine: DocumentEngineService,
    private readonly lifecycle: DocumentLifecycleRegistry,
    private readonly valuation: InventoryValuationService,
    private readonly catalogs: InventoryCatalogsService,
    @Inject('AuditLogsRepository')
    private readonly auditLogs: AuditLogsRepository,
  ) {}

  onModuleInit(): void {
    this.lifecycle.register({
      entityType: INVENTORY_ACT_ENTITY_TYPE,
      // RESPONSABLE = responsable de la toma (responsiblePersonId); AUDITA = quien aprueba la conciliación (signers).
      formats: [
        {
          formatKey: INVENTORY_ACT_FORMAT_KEY,
          process: 'Tomas físicas de inventario',
          signers: { RESPONSABLE: 'RESPONSIBLE', AUDITA: 'REQUEST' },
        },
      ],
      onGenerated: (manager, event) => this.onGenerated(manager, event),
      onSigned: (manager, event) => this.assertOwnAct(manager, event).then(() => undefined),
      onRejected: (manager, event) => this.assertOwnAct(manager, event).then(() => undefined),
    });
  }

  /**
   * En la transacción de approveReconcile, con la toma ya RECONCILED en `inventory` (sin guardar). Nunca hace fallar
   * la conciliación por el acta: el intento va en un SAVEPOINT y cualquier problema queda en act_blocked_*. Deja los
   * campos del acta en `inventory`; quien llama la guarda.
   */
  async enqueueOnApproval(manager: EntityManager, inventory: PhysicalInventory, approver: AuthenticatedUser): Promise<void> {
    const outcome = await this.tryEnqueue(manager, inventory, approver.id);
    this.applyOutcome(inventory, outcome);
    await this.auditEnqueue(manager, inventory, approver.id, outcome);
  }

  /** POST /inventories/:id/act/enqueue: la toma está RECONCILED y su acta no se encoló. */
  async retryEnqueue(inventoryId: string, actor: AuthenticatedUser, signerSubstitutions?: SignerSubstitutionsInput) {
    const outcome = await this.dataSource.transaction(async (manager) => {
      const inventory = await manager
        .getRepository(PhysicalInventory)
        .findOne({ where: { id: inventoryId }, lock: { mode: 'pessimistic_write' } });
      if (!inventory) {
        throw new ApiException(ErrorCode.ResourceNotFound);
      }
      if (inventory.status !== InventoryStatus.Reconciled || inventory.actRequestId) {
        throw new ApiException(
          ErrorCode.InvalidState,
          'El acta se encola solo en una toma conciliada cuya acta no se encoló',
        );
      }
      const result = await this.tryEnqueue(manager, inventory, inventory.reconcileApprovedBy ?? actor.id, signerSubstitutions, {
        rethrowSignerErrors: true,
      });
      this.applyOutcome(inventory, result);
      await manager.getRepository(PhysicalInventory).save(inventory);
      await this.auditEnqueue(manager, inventory, actor.id, result);
      return result;
    });
    if ('blocked' in outcome) {
      throw new ApiException(
        outcome.blocked === 'FORMAT_NOT_READY' ? ErrorCode.DocumentFormatNotReady : ErrorCode.InvalidState,
        outcome.message,
        [{ field: 'reason', message: outcome.blocked }],
      );
    }
    const inventory = await this.dataSource.getRepository(PhysicalInventory).findOneOrFail({ where: { id: inventoryId } });
    return this.state(inventory);
  }

  /** Estado del acta para la pantalla de la toma (InventoryActStateDto). */
  async state(inventory: PhysicalInventory) {
    const base = {
      reason: null as InventoryActReason | null,
      message: null as string | null,
      requestId: inventory.actRequestId ?? null,
      attempts: 0,
      retriesAutomatically: false,
      retryable: false,
      retryAction: null as InventoryActRetryAction | null,
      documentId: inventory.actDocumentId ?? null,
      number: null as string | null,
      status: null as 'PENDING_SIGNATURE' | 'SIGNED' | 'REJECTED' | null,
      signedAt: null as string | null,
      blockedAt: null as Date | null,
    };
    if (!inventory.actRequestId) {
      if (inventory.actBlockedCode) {
        return {
          ...base,
          generation: 'NOT_ENQUEUED' as InventoryActGeneration,
          reason: inventory.actBlockedCode as InventoryActReason,
          message: inventory.actBlockedMessage,
          retryable: true,
          retryAction: 'ENQUEUE' as InventoryActRetryAction,
          blockedAt: inventory.actBlockedAt,
        };
      }
      return { ...base, generation: 'NONE' as InventoryActGeneration };
    }
    const state = await this.lifecycle.stateFor(INVENTORY_ACT_ENTITY_TYPE, inventory.id, {
      formatKey: INVENTORY_ACT_FORMAT_KEY,
    });
    const request = state.requests.find((item) => item.requestId === inventory.actRequestId);
    const documentId = inventory.actDocumentId ?? request?.documentId ?? null;
    const document = documentId ? state.documents.find((item) => item.documentId === documentId) : undefined;
    const generation: InventoryActGeneration = document ? 'GENERATED' : (request?.status ?? 'PENDING');
    const failed = generation === 'FAILED';
    const reason = failed ? await this.failureReason() : null;
    return {
      ...base,
      generation,
      reason,
      message: failed ? (reason === 'TEMPLATE_NOT_ACTIVE' ? TEMPLATE_NOT_ACTIVE_MESSAGE : (request?.lastError ?? null)) : null,
      attempts: request?.attempts ?? 0,
      retriesAutomatically: failed && (request?.attempts ?? 0) < AUTOMATIC_GENERATION_ATTEMPTS,
      retryable: failed && !documentId,
      retryAction: failed && !documentId ? ('RETRY_REQUEST' as InventoryActRetryAction) : null,
      documentId,
      number: document?.number ?? null,
      status: document?.status ?? null,
      signedAt: document?.signedAt ? new Date(document.signedAt).toISOString() : null,
    };
  }

  private async failureReason(): Promise<InventoryActReason> {
    if (!(await this.engine.hasActiveTemplate(INVENTORY_ACT_FORMAT_KEY))) {
      return 'TEMPLATE_NOT_ACTIVE';
    }
    const readiness = await this.engine.formatReadiness(INVENTORY_ACT_FORMAT_KEY).catch(() => null);
    return readiness && !readiness.ready ? 'FORMAT_NOT_READY' : 'GENERATION_FAILED';
  }

  private applyOutcome(inventory: PhysicalInventory, outcome: EnqueueOutcome): void {
    if ('requestId' in outcome) {
      inventory.actRequestId = outcome.requestId;
      inventory.actBlockedCode = null;
      inventory.actBlockedMessage = null;
      inventory.actBlockedAt = null;
      return;
    }
    inventory.actBlockedCode = outcome.blocked;
    inventory.actBlockedMessage = outcome.message;
    inventory.actBlockedAt = new Date();
  }

  private auditEnqueue(manager: EntityManager, inventory: PhysicalInventory, actorId: string, outcome: EnqueueOutcome) {
    return this.auditLogs.record(
      {
        action: AuditAction.InventoryActEnqueued,
        entityType: 'INVENTORY',
        entityId: inventory.id,
        performedBy: actorId,
        ipAddress: null,
        userAgent: null,
        changes:
          'requestId' in outcome
            ? { formatKey: INVENTORY_ACT_FORMAT_KEY, requestId: outcome.requestId }
            : { formatKey: INVENTORY_ACT_FORMAT_KEY, blocked: outcome.blocked },
      },
      manager,
    );
  }

  private async tryEnqueue(
    manager: EntityManager,
    inventory: PhysicalInventory,
    approverUserId: string,
    signerSubstitutions?: SignerSubstitutionsInput,
    options: { readonly rethrowSignerErrors?: boolean } = {},
  ): Promise<EnqueueOutcome> {
    const readiness = await this.engine.formatReadiness(INVENTORY_ACT_FORMAT_KEY, manager).catch((error: unknown) => ({
      ready: false,
      reasons: [error instanceof Error ? error.message : String(error)],
    }));
    if (!readiness.ready) {
      return {
        blocked: 'FORMAT_NOT_READY',
        message: `El formato ${INVENTORY_ACT_FORMAT_KEY} no se puede generar: ${readiness.reasons.join('; ')}`,
      };
    }
    await manager.query('SAVEPOINT inventory_act');
    try {
      // app_user.person_id es NOT NULL: responsable y aprobador siempre tienen persona que firme.
      const responsiblePersonId = await this.personOf(manager, inventory.responsibleUserId);
      const approverPersonId = await this.personOf(manager, approverUserId);
      const payload = await this.payload(manager, inventory, responsiblePersonId, approverPersonId);
      // Separación de funciones: si quien aprueba (AUDITA) es el responsable de la toma, el acta necesita un sustituto
      // de Control Interno (POST /inventories/:id/act/enqueue con signerSubstitutions.AUDITA).
      const requestId = await this.engine.enqueue(
        manager,
        signerSubstitutions && Object.keys(signerSubstitutions).length > 0 ? { ...payload, signerSubstitutions } : payload,
        approverUserId,
      );
      await manager.query('RELEASE SAVEPOINT inventory_act');
      return { requestId };
    } catch (error) {
      await manager.query('ROLLBACK TO SAVEPOINT inventory_act');
      // Encolado manual: los errores de separación de funciones salen tal cual (409 DOCUMENT_SIGNER_DUPLICATED, 400
      // DOCUMENT_SIGNER_SUBSTITUTE_INVALID, con sus details), como en entregas, préstamos y traslados. Al aprobar la
      // conciliación nunca se lanza: queda NOT_ENQUEUED/ENQUEUE_FAILED con el motivo.
      if (options.rethrowSignerErrors && error instanceof ApiException && SIGNER_ERRORS.includes(error.code)) {
        throw error;
      }
      return {
        blocked: 'ENQUEUE_FAILED',
        message: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
      };
    }
  }

  private async personOf(manager: EntityManager, userId: string): Promise<string> {
    const [row] = (await manager.query('SELECT person_id FROM app_user WHERE id = $1', [userId])) as Array<{
      person_id: string;
    }>;
    if (!row) {
      throw new Error(`No existe el usuario ${userId} que firma el acta`);
    }
    return row.person_id;
  }

  private async payload(
    manager: EntityManager,
    inventory: PhysicalInventory,
    responsiblePersonId: string,
    approverPersonId: string,
  ): Promise<DocumentRequestPayload> {
    const rows = (await manager.query(
      `
      SELECT i.id, i.asset_id, i.verification_result, i.actual_condition, i.expected_code_temporary,
             i.finding_category_code, i.missing_cause_id, i.missing_cause_other, i.notes,
             (i.voided_at IS NOT NULL) AS voided, l.name AS location_name, i.resolved_asset_id,
             ra.internal_code AS resolved_asset_code, i.surplus_resolution, i.surplus_resolution_reason
      FROM physical_inventory_item i
      LEFT JOIN location l ON l.id = i.actual_location_id
      LEFT JOIN asset ra ON ra.id = i.resolved_asset_id
      WHERE i.inventory_id = $1
      ORDER BY i.verified_at NULLS LAST, i.id
      `,
      [inventory.id],
    )) as ActItemRow[];
    const items: ActItem[] = rows.map((row) => ({
      id: row.id,
      assetId: row.asset_id,
      result: row.verification_result,
      actualCondition: row.actual_condition,
      expectedCodeTemporary: row.expected_code_temporary,
      findingCategoryCode: row.finding_category_code,
      missingCauseId: row.missing_cause_id,
      missingCauseOther: row.missing_cause_other,
      notes: row.notes,
      voided: row.voided,
      actualLocationName: row.location_name,
      resolvedAssetId: row.resolved_asset_id,
      resolvedAssetCode: row.resolved_asset_code,
      surplusResolution: row.surplus_resolution,
      surplusResolutionReason: row.surplus_resolution_reason,
    }));
    const basis = await this.valuation.basis(inventory, manager);
    const valuations = await this.valuation.valuations(
      inventory,
      items.flatMap((item) => [item.assetId, item.resolvedAssetId]).filter((id): id is string => !!id),
      manager,
      basis,
    );
    const catalogs = await this.catalogs.viewContext();
    const categories = (
      (await manager.query(
        `SELECT code, label FROM inventory_finding_category
         WHERE is_active AND NOT pending_definition ORDER BY sort_order, code`,
      )) as Array<{ code: string; label: string }>
    ).map((row) => ({ code: row.code, label: row.label }));
    const content = buildInventoryActContent({
      code: inventory.code,
      name: inventory.name,
      scopeLabel: await this.scopeLabel(manager, inventory),
      plannedStartDate: inventory.plannedStartDate,
      plannedEndDate: inventory.plannedEndDate,
      actualStartDate: inventory.actualStartDate,
      actualEndDate: inventory.actualEndDate,
      approvedAt: inventory.reconcileApprovedAt ?? new Date(),
      basis,
      items,
      categories,
      causeLabels: catalogs.causeLabels,
      valuations,
      conditionLabels: CONDITION_LABELS,
    });
    return {
      formatKey: INVENTORY_ACT_FORMAT_KEY,
      entityType: INVENTORY_ACT_ENTITY_TYPE,
      entityId: inventory.id,
      ...(inventory.scopeType === InventoryScopeType.CostCenter && inventory.scopeId
        ? { costCenterId: inventory.scopeId }
        : {}),
      responsiblePersonId,
      signers: { AUDITA: approverPersonId },
      assetIds: content.assetIds,
      assetNotes: content.assetNotes,
      assetFields: content.assetFields,
      fields: content.fields,
      tables: content.tables,
    };
  }

  private async scopeLabel(manager: EntityManager, inventory: PhysicalInventory): Promise<string> {
    const one = async (sql: string): Promise<string> => {
      const [row] = (await manager.query(sql, [inventory.scopeId])) as Array<{ label: string }>;
      return row?.label ?? '';
    };
    switch (inventory.scopeType) {
      case InventoryScopeType.CostCenter:
        return one(`SELECT 'Centro de costo ' || external_code || ' — ' || name AS label FROM cost_center WHERE id = $1`);
      case InventoryScopeType.Location:
        return one(`SELECT 'Ubicación ' || code || ' — ' || name AS label FROM location WHERE id = $1`);
      case InventoryScopeType.Global:
        return 'Toda la universidad';
      default:
        return one(`SELECT 'Unidad organizacional ' || name AS label FROM organizational_unit WHERE id = $1`);
    }
  }

  // ---------- Ciclo de vida del acta ----------

  private async lockFor(manager: EntityManager, event: DocumentLifecycleEvent) {
    if (event.formatKey !== INVENTORY_ACT_FORMAT_KEY) {
      throw new Error(`El acta ${event.number} es ${event.formatKey}, no ${INVENTORY_ACT_FORMAT_KEY}`);
    }
    const [row] = event.entityId
      ? ((await manager.query(
          `SELECT id, status, act_request_id, act_document_id FROM physical_inventory WHERE id = $1 FOR UPDATE`,
          [event.entityId],
        )) as Array<{ id: string; status: string; act_request_id: string | null; act_document_id: string | null }>)
      : [];
    if (!row) {
      throw new Error(`No existe la toma ${event.entityId ?? '(sin id)'} del acta ${event.number}`);
    }
    return row;
  }

  /** En la transacción que inserta el acta: la toma la adopta si la encoló y aún no tiene otra. */
  private async onGenerated(manager: EntityManager, event: DocumentLifecycleEvent): Promise<void> {
    const inventory = await this.lockFor(manager, event);
    if (inventory.status !== InventoryStatus.Reconciled || !inventory.act_request_id) {
      throw new Error(`La toma ${inventory.id} no encoló un acta (${inventory.status})`);
    }
    if (inventory.act_document_id && inventory.act_document_id !== event.documentId) {
      throw new Error(`La toma ${inventory.id} ya tiene acta (${inventory.act_document_id})`);
    }
    await manager.query('UPDATE physical_inventory SET act_document_id = $2 WHERE id = $1', [
      inventory.id,
      event.documentId,
    ]);
  }

  /** Firmar o rechazar el acta no cambia la toma; solo se comprueba que es la suya. */
  private async assertOwnAct(manager: EntityManager, event: DocumentLifecycleEvent) {
    const inventory = await this.lockFor(manager, event);
    if (inventory.act_document_id !== event.documentId) {
      throw new Error(
        `El acta ${event.number} (${event.documentId}) no es la de la toma ${inventory.id} (${inventory.act_document_id ?? 'sin acta'})`,
      );
    }
    return inventory;
  }
}

export type InventoryActState = Awaited<ReturnType<InventoryActService['state']>>;

