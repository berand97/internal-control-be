import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { DataSource, type EntityManager, In } from 'typeorm';
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
  ITEM_ACT_CENTER_SQL,
  type InventoryActGeneration,
  type InventoryActReason,
  type InventoryActRetryAction,
} from '../domain/inventory-act.js';
import type { SignerSubstitutionsInput } from '../../documents/dto/signer-substitution.dto.js';
import { PhysicalInventory } from '../entities/physical-inventory.entity.js';
import { PhysicalInventoryAct } from '../entities/physical-inventory-act.entity.js';
import { InventoryScopeType } from '../enums/inventory-scope.js';
import { InventoryStatus } from '../enums/inventory-status.js';
import { VerificationResult } from '../enums/verification-result.js';
import { InventoryCatalogsService } from './inventory-catalogs.service.js';
import {
  type CostCenterRef,
  InventorySignerHeadService,
  type InventoryWarning,
} from './inventory-signer-head.service.js';
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
  'FORMAT_NOT_READY' | 'ENQUEUE_FAILED' | 'NO_COST_CENTER_HEAD' | 'SIGNER_HEAD_NOT_CHOSEN'
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

export interface PersonRef {
  readonly personId: string;
  readonly name: string;
}

/**
 * Actas OCI-21-37 de una toma: una por centro de costo (physical_inventory_act). Al aprobar la conciliación se encola
 * una por centro en la misma transacción, cada una en su SAVEPOINT: si el formato no está listo, el centro no tiene
 * jefe que firme o falla armarla, esa acta queda NOT_ENQUEUED con su motivo, las demás siguen y la conciliación
 * también; se reintenta con POST /inventories/:id/acts/:costCenterId/enqueue. Cada acta lleva su propio consecutivo
 * (lo asigna el motor al generarla), su centroCosto (y unidad a la fecha), los hallazgos y sobrantes de su centro y,
 * como ENCARGADO, el jefe de ese centro. La generación es asíncrona (outbox). Los manejadores del ciclo de vida solo
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
    private readonly signerHead: InventorySignerHeadService,
    @Inject('AuditLogsRepository')
    private readonly auditLogs: AuditLogsRepository,
  ) {}

  onModuleInit(): void {
    this.lifecycle.register({
      entityType: INVENTORY_ACT_ENTITY_TYPE,
      // RESPONSABLE (ENCARGADO) = jefe vigente del centro del acta resuelto al cerrar (responsiblePersonId);
      // AUDITA (REVISA) = quien aprueba la conciliación (signers), turno de Control Interno.
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
      links: async (manager, entityId) => {
        const [row] = (await manager.query(
          'SELECT inventory_id AS "inventoryId", cost_center_id AS "costCenterId" FROM physical_inventory_act WHERE id = $1',
          [entityId],
        )) as Array<{ inventoryId: string; costCenterId: string | null }>;
        return row ?? {};
      },
    });
  }

  /**
   * En la transacción de approveReconcile, con la toma ya RECONCILED en `inventory` (sin guardar): alinea las actas con
   * los ítems y encola cada una sin encolar. Nunca hace fallar la conciliación por un acta.
   */
  async enqueueOnApproval(manager: EntityManager, inventory: PhysicalInventory, approver: AuthenticatedUser): Promise<void> {
    await this.signerHead.sync(manager, inventory, approver);
    const acts = await this.orderedActs(manager, inventory.id);
    for (const act of acts.filter((row) => !row.documentRequestId)) {
      const outcome = await this.tryEnqueue(manager, inventory, act, approver.id);
      this.applyOutcome(act, outcome);
      await manager.getRepository(PhysicalInventoryAct).save(act);
      await this.auditEnqueue(manager, inventory, act, approver.id, outcome);
    }
  }

  /**
   * POST /inventories/:id/acts/:costCenterId/enqueue: la toma está RECONCILED y el acta de ese centro no se encoló.
   * costCenterId null (POST /inventories/:id/act/enqueue, compatibilidad): la única acta de la toma.
   */
  async retryEnqueue(
    inventoryId: string,
    costCenterId: string | null,
    actor: AuthenticatedUser,
    signerSubstitutions?: SignerSubstitutionsInput,
  ) {
    const { outcome, actId } = await this.dataSource.transaction(async (manager) => {
      const inventory = await manager
        .getRepository(PhysicalInventory)
        .findOne({ where: { id: inventoryId }, lock: { mode: 'pessimistic_write' } });
      if (!inventory) {
        throw new ApiException(ErrorCode.ResourceNotFound);
      }
      const act = await this.signerHead.actFor(manager, inventory.id, costCenterId);
      if (inventory.status !== InventoryStatus.Reconciled || act.documentRequestId) {
        throw new ApiException(
          ErrorCode.InvalidState,
          'El acta se encola solo en una toma conciliada cuya acta no se encoló',
        );
      }
      const result = await this.tryEnqueue(manager, inventory, act, inventory.reconcileApprovedBy ?? actor.id, signerSubstitutions, {
        rethrowSignerErrors: true,
      });
      this.applyOutcome(act, result);
      await manager.getRepository(PhysicalInventoryAct).save(act);
      await this.auditEnqueue(manager, inventory, act, actor.id, result);
      return { outcome: result, actId: act.id };
    });
    if ('blocked' in outcome) {
      throw new ApiException(
        outcome.blocked === 'FORMAT_NOT_READY' ? ErrorCode.DocumentFormatNotReady : ErrorCode.InvalidState,
        outcome.message,
        [{ field: 'reason', message: outcome.blocked }],
      );
    }
    const inventory = await this.dataSource.getRepository(PhysicalInventory).findOneOrFail({ where: { id: inventoryId } });
    const views = await this.views(inventory);
    return views.find((view) => view.id === actId) as InventoryActView;
  }

  /**
   * Para el detalle de la toma: las actas (una por centro) y, por compatibilidad, el estado de la única acta (act,
   * signerHead, attendedBy; null con varias), si todas se pueden emitir y los avisos de todas.
   */
  async detail(inventory: PhysicalInventory) {
    const acts = await this.views(inventory);
    const single = acts.length === 1 ? (acts[0] as InventoryActView) : null;
    return {
      acts,
      act: single ? this.stateOf(single) : acts.length === 0 ? this.noneState() : null,
      signerHead: single?.signerHead ?? null,
      attendedBy: single?.attendedBy ?? null,
      actIssuable: acts.every((act) => act.issuable),
      warnings: acts.flatMap((act) => act.warnings),
      unassignedItems: await this.signerHead.unassignedItems(inventory),
    };
  }

  private stateOf(view: InventoryActView): InventoryActState {
    const {
      id: _id,
      costCenter: _costCenter,
      signerHead: _signerHead,
      attendedBy: _attendedBy,
      issuable: _issuable,
      warnings: _warnings,
      ...state
    } = view;
    return state;
  }

  private noneState(): InventoryActState {
    return {
      generation: 'NONE',
      reason: null,
      message: null,
      requestId: null,
      attempts: 0,
      retriesAutomatically: false,
      retryable: false,
      retryAction: null,
      documentId: null,
      number: null,
      status: null,
      signedAt: null,
      blockedAt: null,
    };
  }

  /** Actas de la toma con su centro, firmante, quién atendió, estado y avisos, por código de centro. */
  async views(inventory: PhysicalInventory): Promise<InventoryActView[]> {
    const manager = this.dataSource.manager;
    const acts = await this.orderedActs(manager, inventory.id);
    if (acts.length === 0) {
      return [];
    }
    const centers = acts.map((act) => act.costCenterId).filter((id): id is string => id !== null);
    const refs = await this.signerHead.costCenters(manager, centers);
    const names = await this.signerHead.personNames(
      manager,
      acts.flatMap((act) => [act.signerHeadPersonId, act.attendedByPersonId]),
    );
    const closed = inventory.status === InventoryStatus.Closed || inventory.status === InventoryStatus.Reconciled;
    const unsigned = acts
      .filter((act) => closed && !act.signerHeadPersonId && !act.documentRequestId && act.costCenterId)
      .map((act) => act.costCenterId as string);
    const candidates = unsigned.length > 0 ? await this.signerHead.candidatesByCenter(manager, unsigned) : new Map();
    const views: InventoryActView[] = [];
    for (const act of acts) {
      const costCenter = act.costCenterId ? (refs.get(act.costCenterId) ?? null) : null;
      const issuable = act.signerHeadPersonId !== null || act.documentRequestId !== null;
      const warnings: InventoryWarning[] =
        closed && !issuable
          ? [this.signerHead.warning(costCenter, (candidates.get(act.costCenterId as string) ?? []).length)]
          : [];
      views.push({
        id: act.id,
        costCenter,
        signerHead: act.signerHeadPersonId
          ? { personId: act.signerHeadPersonId, name: names.get(act.signerHeadPersonId) ?? '' }
          : null,
        attendedBy: act.attendedByPersonId
          ? { personId: act.attendedByPersonId, name: names.get(act.attendedByPersonId) ?? '' }
          : act.attendedByName
            ? { personId: null, name: act.attendedByName }
            : null,
        issuable,
        warnings,
        ...(await this.state(act)),
      });
    }
    return views;
  }

  private async orderedActs(manager: EntityManager, inventoryId: string): Promise<PhysicalInventoryAct[]> {
    const ids = (await manager.query(
      `SELECT a.id FROM physical_inventory_act a LEFT JOIN cost_center cc ON cc.id = a.cost_center_id
       WHERE a.inventory_id = $1 ORDER BY cc.external_code NULLS FIRST, a.id`,
      [inventoryId],
    )) as Array<{ id: string }>;
    const rows = await manager.getRepository(PhysicalInventoryAct).findBy({ id: In(ids.map((row) => row.id)) });
    return ids.map((row) => rows.find((act) => act.id === row.id) as PhysicalInventoryAct);
  }

  /** Estado de generación de un acta (InventoryActStateDto). */
  private async state(act: PhysicalInventoryAct): Promise<InventoryActState> {
    const base = { ...this.noneState(), requestId: act.documentRequestId, documentId: act.documentId };
    if (!act.documentRequestId) {
      if (act.blockedCode) {
        return {
          ...base,
          generation: 'NOT_ENQUEUED',
          reason: act.blockedCode as InventoryActReason,
          message: act.blockedMessage,
          retryable: true,
          retryAction: 'ENQUEUE',
          blockedAt: act.blockedAt ? new Date(act.blockedAt).toISOString() : null,
        };
      }
      return base;
    }
    const state = await this.lifecycle.stateFor(INVENTORY_ACT_ENTITY_TYPE, act.id, {
      formatKey: INVENTORY_ACT_FORMAT_KEY,
    });
    const request = state.requests.find((item) => item.requestId === act.documentRequestId);
    const documentId = act.documentId ?? request?.documentId ?? null;
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
      retryAction: failed && !documentId ? 'RETRY_REQUEST' : null,
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

  private applyOutcome(act: PhysicalInventoryAct, outcome: EnqueueOutcome): void {
    act.updatedAt = new Date();
    if ('requestId' in outcome) {
      act.documentRequestId = outcome.requestId;
      act.blockedCode = null;
      act.blockedMessage = null;
      act.blockedAt = null;
      return;
    }
    act.blockedCode = outcome.blocked;
    act.blockedMessage = outcome.message;
    act.blockedAt = new Date();
  }

  private auditEnqueue(
    manager: EntityManager,
    inventory: PhysicalInventory,
    act: PhysicalInventoryAct,
    actorId: string,
    outcome: EnqueueOutcome,
  ) {
    const base = { formatKey: INVENTORY_ACT_FORMAT_KEY, actId: act.id, costCenterId: act.costCenterId };
    return this.auditLogs.record(
      {
        action: AuditAction.InventoryActEnqueued,
        entityType: 'INVENTORY',
        entityId: inventory.id,
        performedBy: actorId,
        ipAddress: null,
        userAgent: null,
        changes: 'requestId' in outcome ? { ...base, requestId: outcome.requestId } : { ...base, blocked: outcome.blocked },
      },
      manager,
    );
  }

  private async tryEnqueue(
    manager: EntityManager,
    inventory: PhysicalInventory,
    act: PhysicalInventoryAct,
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
    // Sin jefe del centro que firme como ENCARGADO esta acta no se emite (aviso ACT_CANNOT_BE_ISSUED); las demás sí.
    const signerHeadPersonId = act.signerHeadPersonId;
    if (!signerHeadPersonId || !act.costCenterId) {
      const center = act.costCenterId
        ? ((await this.signerHead.costCenters(manager, [act.costCenterId])).get(act.costCenterId) ?? null)
        : null;
      const candidates = act.costCenterId
        ? ((await this.signerHead.candidatesByCenter(manager, [act.costCenterId])).get(act.costCenterId) ?? []).length
        : 0;
      return {
        blocked: candidates > 1 ? 'SIGNER_HEAD_NOT_CHOSEN' : 'NO_COST_CENTER_HEAD',
        message: this.signerHead.warning(center, candidates).message,
      };
    }
    await manager.query('SAVEPOINT inventory_act');
    try {
      // app_user.person_id es NOT NULL: el aprobador siempre tiene persona que firme.
      const approverPersonId = await this.personOf(manager, approverUserId);
      const payload = await this.payload(manager, inventory, act, signerHeadPersonId, approverPersonId);
      // Separación de funciones: si quien aprueba (AUDITA) es el jefe que firma como ENCARGADO, el acta necesita un
      // sustituto de Control Interno (POST /inventories/:id/acts/:costCenterId/enqueue con signerSubstitutions.AUDITA).
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

  /** Solicitud del acta de un centro: solo los ítems de ese centro (ITEM_ACT_CENTER_SQL). */
  private async payload(
    manager: EntityManager,
    inventory: PhysicalInventory,
    act: PhysicalInventoryAct,
    responsiblePersonId: string,
    approverPersonId: string,
  ): Promise<DocumentRequestPayload> {
    const costCenterId = act.costCenterId as string;
    const rows = (await manager.query(
      `
      SELECT i.id, i.asset_id, i.verification_result, i.actual_condition, i.expected_code_temporary,
             i.finding_category_code, i.missing_cause_id, i.missing_cause_other, i.notes,
             (i.voided_at IS NOT NULL) AS voided, l.name AS location_name, i.resolved_asset_id,
             ra.internal_code AS resolved_asset_code, i.surplus_resolution, i.surplus_resolution_reason
      FROM physical_inventory_item i
      LEFT JOIN location l ON l.id = i.actual_location_id
      LEFT JOIN asset a ON a.id = i.asset_id
      LEFT JOIN asset ra ON ra.id = i.resolved_asset_id
      WHERE i.inventory_id = $1 AND (${ITEM_ACT_CENTER_SQL}) = $4::uuid
      ORDER BY i.verified_at NULLS LAST, i.id
      `,
      [inventory.id, inventory.scopeType, inventory.scopeId, costCenterId],
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
         WHERE is_active ORDER BY sort_order, code`,
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
      attendedBy: await this.signerHead.attendedName(manager, act),
    });
    return {
      formatKey: INVENTORY_ACT_FORMAT_KEY,
      entityType: INVENTORY_ACT_ENTITY_TYPE,
      entityId: act.id,
      costCenterId,
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
          `SELECT a.id, a.inventory_id, pi.status, a.document_request_id, a.document_id
           FROM physical_inventory_act a JOIN physical_inventory pi ON pi.id = a.inventory_id
           WHERE a.id = $1 FOR UPDATE OF a`,
          [event.entityId],
        )) as Array<{
          id: string;
          inventory_id: string;
          status: string;
          document_request_id: string | null;
          document_id: string | null;
        }>)
      : [];
    if (!row) {
      throw new Error(`No existe el acta de toma ${event.entityId ?? '(sin id)'} del documento ${event.number}`);
    }
    return row;
  }

  /** En la transacción que inserta el acta: la fila del centro la adopta si la encoló y aún no tiene otra. */
  private async onGenerated(manager: EntityManager, event: DocumentLifecycleEvent): Promise<void> {
    const act = await this.lockFor(manager, event);
    if (act.status !== InventoryStatus.Reconciled || !act.document_request_id) {
      throw new Error(`La toma ${act.inventory_id} no encoló el acta ${act.id} (${act.status})`);
    }
    if (act.document_id && act.document_id !== event.documentId) {
      throw new Error(`El acta ${act.id} de la toma ${act.inventory_id} ya tiene documento (${act.document_id})`);
    }
    await manager.query('UPDATE physical_inventory_act SET document_id = $2, updated_at = NOW() WHERE id = $1', [
      act.id,
      event.documentId,
    ]);
  }

  /** Firmar o rechazar el acta no cambia la toma; solo se comprueba que es la suya. */
  private async assertOwnAct(manager: EntityManager, event: DocumentLifecycleEvent) {
    const act = await this.lockFor(manager, event);
    if (act.document_id !== event.documentId) {
      throw new Error(
        `El documento ${event.number} (${event.documentId}) no es el acta ${act.id} de la toma ${act.inventory_id} (${act.document_id ?? 'sin documento'})`,
      );
    }
    return act;
  }
}

export interface InventoryActState {
  readonly generation: InventoryActGeneration;
  readonly reason: InventoryActReason | null;
  readonly message: string | null;
  readonly requestId: string | null;
  readonly attempts: number;
  readonly retriesAutomatically: boolean;
  readonly retryable: boolean;
  readonly retryAction: InventoryActRetryAction | null;
  readonly documentId: string | null;
  readonly number: string | null;
  readonly status: 'PENDING_SIGNATURE' | 'SIGNED' | 'REJECTED' | null;
  readonly signedAt: string | null;
  readonly blockedAt: string | null;
}

export interface InventoryActView extends InventoryActState {
  /** Fila physical_inventory_act (entityId del acta en el motor). */
  readonly id: string;
  readonly costCenter: CostCenterRef | null;
  readonly signerHead: PersonRef | null;
  readonly attendedBy: { readonly personId: string | null; readonly name: string } | null;
  readonly issuable: boolean;
  readonly warnings: InventoryWarning[];
}
