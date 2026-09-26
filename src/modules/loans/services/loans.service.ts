import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, type EntityManager, In, Repository } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { Person } from '../../auth/entities/person.entity.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import { Asset } from '../../assets/entities/asset.entity.js';
import { MovementType } from '../../assets/enums/movement-type.enum.js';
import { OperationalStatus } from '../../assets/enums/operational-status.enum.js';
import { PhysicalCondition } from '../../assets/enums/physical-condition.enum.js';
import { AssetStateService } from '../../assets/services/asset-state.service.js';
import type { UpdateAssetRecord } from '../../assets/repositories/assets.repository.interface.js';
import { CostCenter } from '../../cost-centers/entities/cost-center.entity.js';
import { DocumentLifecycleRegistry } from '../../documents/lifecycle/document-lifecycle.registry.js';
import {
  type DocumentRequestPayload,
  DocumentEngineService,
} from '../../documents/services/document-engine.service.js';
import { costCenterFilter, type ReadableCostCenterScope } from '../../roles/services/cost-center-scope.js';
import { PermissionsService } from '../../roles/services/permissions.service.js';
import {
  assertLoanInApprovalScope,
  LOAN_APPROVE_GLOBAL,
  LOAN_APPROVE_SCOPED,
  LOAN_READ_GLOBAL,
  LOAN_READ_SCOPED,
  requireApprovalScope,
  requireReadScope,
} from '../domain/loan-approval.js';
import {
  bogotaDate,
  daysOverdue,
  longSpanishDate,
  SQL_BOGOTA_TODAY,
  usageBetween,
} from '../domain/loan-dates.js';
import { LOAN_DELIVERY_FORMAT, LOAN_DOCUMENT_ENTITY, LOAN_RETURN_FORMAT } from '../domain/loan-documents.js';
import { assertLoanTransition, statusAfterReception } from '../domain/loan-transitions.js';
import {
  CreateLoanDto,
  DeliverLoanDto,
  ExtendLoanDto,
  QueryLoansDto,
  ReceiveReturnDto,
  RegenerateDeliveryActDto,
  RejectLoanDto,
  ReturnLoanDto,
  UndoDeliveryDto,
} from '../dto/loan.dto.js';
import type { LoanDeliveryActStatus, LoanReturnActStatus } from '../dto/loan.responses.js';
import { AssetLoan } from '../entities/asset-loan.entity.js';
import {
  AssetLoanEvent,
  AssetLoanItem,
  LoanAttachment,
} from '../entities/asset-loan-item.entity.js';
import {
  ACTIVE_LOAN_STATUSES,
  LOAN_OUT_STATUSES,
  LOAN_OVERDUE_CANDIDATE_STATUSES,
  type LoanReturnCondition,
  type LoanStatus,
  OPEN_LOAN_STATUSES,
} from '../enums/loan-status.js';

const LOANABLE: ReadonlyArray<OperationalStatus> = [
  OperationalStatus.InUse,
  OperationalStatus.InStorage,
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RETURN_CONDITION_LABELS: Record<LoanReturnCondition, string> = {
  GOOD: 'Bueno',
  DAMAGED: 'Dañado',
  LOST: 'Perdido',
};

/** Mismas etiquetas que el motor de actas (CONDITION_LABELS de DocumentEngineService). */
const PHYSICAL_CONDITION_LABELS: Record<string, string> = {
  NEW: 'Nuevo',
  GOOD: 'Bueno',
  FAIR: 'Regular',
  POOR: 'Malo',
  OBSOLETE: 'Obsoleto',
};

interface ReturnActEventPayload {
  readonly status?: 'PENDING_FORMAT' | 'REQUESTED';
  readonly documentRequestId?: string;
  readonly reasons?: ReadonlyArray<string>;
}

/**
 * Préstamo temporal de activos entre dependencias (decisiones en docs/decisiones.md):
 *
 * - El préstamo se otorga a una DEPENDENCIA (centro de costo de destino), no a una persona. La persona de contacto
 *   (asset_loan.target_responsible_id) es quien firma RECIBE, pero no pasa a ser responsable de los activos: el
 *   responsable y el centro de costo del activo NO cambian durante el préstamo (la entrega solo cambia el estado
 *   operativo a ON_LOAN). El acta OCI-01-65 usa el centro de costo de ORIGEN. Origen ≠ destino.
 * - La entrega física registra el movimiento LOAN y deja los activos ON_LOAN en el momento en que salen, y el
 *   préstamo queda PENDING_SIGNATURES; pasa a ACTIVE en la transacción que completa las firmas del acta (onSigned,
 *   LoanDeliveryActLifecycle). Acta rechazada: nueva acta (regenerateDeliveryAct) o deshacer la entrega
 *   (undoDelivery, anula el acta con voidForEntity y revierte los activos con movimiento RETURN).
 * - La devolución tiene su propia acta (LOAN_RETURN), cuyo formato institucional aún no existe: la recepción se
 *   registra igual y el acta queda PENDING_FORMAT.
 */
@Injectable()
export class LoansService {
  constructor(
    @InjectRepository(AssetLoan)
    private readonly loans: Repository<AssetLoan>,
    @InjectRepository(AssetLoanItem)
    private readonly items: Repository<AssetLoanItem>,
    @InjectRepository(AssetLoanEvent)
    private readonly events: Repository<AssetLoanEvent>,
    @InjectRepository(LoanAttachment)
    private readonly attachments: Repository<LoanAttachment>,
    @InjectRepository(Asset)
    private readonly assets: Repository<Asset>,
    private readonly dataSource: DataSource,
    private readonly assetState: AssetStateService,
    private readonly documents: DocumentEngineService,
    private readonly documentLifecycle: DocumentLifecycleRegistry,
    private readonly permissions: PermissionsService,
    @Inject('AuditLogsRepository')
    private readonly auditLogsRepository: AuditLogsRepository,
  ) {}

  /** Alcance de lectura del usuario (403 si no tiene ninguno de los dos permisos o no alcanza centros). */
  private async readScope(actor: AuthenticatedUser): Promise<ReadableCostCenterScope> {
    return requireReadScope(await this.permissions.costCenterScope(actor.id, LOAN_READ_GLOBAL, LOAN_READ_SCOPED));
  }

  async list(query: QueryLoansDto, actor: AuthenticatedUser) {
    const scope = costCenterFilter(await this.readScope(actor));
    const page = Number(query.page) || 1;
    const pageSize = Math.min(Number(query.pageSize) || 20, 100);
    const qb = this.loans.createQueryBuilder('l');
    if (scope) {
      qb.andWhere('(l.source_cost_center_id IN (:...scope) OR l.target_cost_center_id IN (:...scope))', { scope });
    }
    if (query.status) {
      qb.andWhere('l.status = :status', { status: query.status });
    }
    if (query.sourceCostCenterId) {
      qb.andWhere('l.source_cost_center_id = :source', {
        source: query.sourceCostCenterId,
      });
    }
    if (query.targetCostCenterId) {
      qb.andWhere('l.target_cost_center_id = :target', {
        target: query.targetCostCenterId,
      });
    }
    if (query.requestedBy) {
      qb.andWhere('l.requested_by = :requestedBy', {
        requestedBy: query.requestedBy,
      });
    }
    if (query.overdue === 'true') {
      qb.andWhere(
        `l.status IN (:...overdueCandidates) AND l.expected_return_date < ${SQL_BOGOTA_TODAY}`,
        { overdueCandidates: LOAN_OVERDUE_CANDIDATE_STATUSES },
      );
    }
    if (query.active === 'true') {
      qb.andWhere('l.status IN (:...out)', { out: LOAN_OUT_STATUSES });
    }
    const total = await qb.getCount();
    const rows = await qb
      .orderBy('l.requested_at', 'DESC')
      .addOrderBy('l.id', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getMany();
    const today = bogotaDate(new Date());
    return {
      items: rows.map((row) => this.toSummary(row, today)),
      page,
      pageSize,
      total,
      hasNext: page * pageSize < total,
    };
  }

  /**
   * Alertas de vencidos: préstamos con activos fuera y sin recepción en curso (LOAN_OVERDUE_CANDIDATE_STATUSES) con
   * la fecha estimada anterior a hoy (Bogotá), aunque el job diario todavía no los haya marcado OVERDUE. Filtro,
   * alcance y días de atraso en SQL; los más atrasados primero.
   */
  async overdue(actor: AuthenticatedUser) {
    const scope = costCenterFilter(await this.readScope(actor));
    const qb = this.loans
      .createQueryBuilder('l')
      .addSelect(`(${SQL_BOGOTA_TODAY} - l.expected_return_date)`, 'days_overdue')
      .where('l.status IN (:...candidates)', { candidates: LOAN_OVERDUE_CANDIDATE_STATUSES })
      .andWhere(`l.expected_return_date < ${SQL_BOGOTA_TODAY}`);
    if (scope) {
      qb.andWhere('(l.source_cost_center_id IN (:...scope) OR l.target_cost_center_id IN (:...scope))', { scope });
    }
    const { entities, raw } = await qb
      .orderBy('l.expected_return_date', 'ASC')
      .addOrderBy('l.id', 'ASC')
      .getRawAndEntities<{ days_overdue: number | string }>();
    const today = bogotaDate(new Date());
    return entities.map((row, index) => ({
      ...this.toSummary(row, today),
      daysOverdue: Number(raw[index]?.days_overdue ?? 0),
    }));
  }

  /** Detalle con alcance de lectura: fuera de alcance responde 404, igual que un préstamo inexistente. */
  async getById(id: string, actor: AuthenticatedUser) {
    const scope = costCenterFilter(await this.readScope(actor));
    const qb = this.loans.createQueryBuilder('l').where('l.id = :id', { id });
    if (scope) {
      qb.andWhere('(l.source_cost_center_id IN (:...scope) OR l.target_cost_center_id IN (:...scope))', { scope });
    }
    const loan = await qb.getOne();
    if (!loan) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return this.detail(loan);
  }

  /** Detalle sin comprobar alcance: respuesta de las acciones, que ya exigieron su propio permiso. */
  private async detailById(id: string) {
    return this.detail(await this.requireLoan(id));
  }

  private async detail(loan: AssetLoan) {
    const id = loan.id;
    const items = await this.items.find({ where: { loanId: id } });
    const assets = items.length
      ? await this.assets.find({ where: { id: In(items.map((item) => item.assetId)) } })
      : [];
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    const events = await this.events.find({
      where: { loanId: id },
      order: { createdAt: 'ASC' },
    });
    const attachments = await this.attachments.find({ where: { loanId: id } });
    const returnFormat = this.documents.formatReadiness(LOAN_RETURN_FORMAT);
    return {
      ...this.toSummary(loan, bogotaDate(new Date())),
      items: items
        .map((item) => ({
          id: item.id,
          loanId: item.loanId,
          assetId: item.assetId,
          internalCode: byId.get(item.assetId)?.internalCode ?? null,
          description: byId.get(item.assetId)?.description ?? null,
          sourceCostCenterId: item.sourceCostCenterId,
          statusOnLoan: item.statusOnLoan,
          conditionOnDelivery: item.conditionOnDelivery,
          returnCondition: item.returnCondition,
          returnedAt: item.returnedAt,
          receivedAt: item.receivedAt,
          outstanding: loan.deliveredAt !== null && item.receivedAt === null && loan.status !== 'CANCELLED',
        }))
        .sort((a, b) => (a.internalCode ?? '').localeCompare(b.internalCode ?? '') || a.id.localeCompare(b.id)),
      events,
      attachments,
      deliveryAct: await this.deliveryAct(loan),
      returnActFormat: {
        formatKey: returnFormat.format.key,
        sgcCode: returnFormat.format.sgcCode,
        ready: returnFormat.ready,
        pendingDecisions: [...returnFormat.format.pendingDecisions],
      },
      returnActs: await this.returnActs(loan, events),
    };
  }

  /**
   * Solicitud, en UNA transacción con las filas de los activos bloqueadas (FOR UPDATE, en orden de id): la
   * disponibilidad se comprueba dentro, así dos solicitudes concurrentes con el mismo activo se serializan y la
   * segunda ve la primera. Un activo en un préstamo abierto (OPEN_LOAN_STATUSES, incluida otra solicitud) no entra.
   */
  async create(dto: CreateLoanDto, actor: AuthenticatedUser) {
    const uniqueIds = [...new Set(dto.assets)];
    const loanId = await this.dataSource.transaction(async (manager) => {
      const assets = await manager.find(Asset, {
        where: { id: In(uniqueIds) },
        order: { id: 'ASC' },
        lock: { mode: 'pessimistic_write' },
      });
      if (assets.length !== uniqueIds.length) {
        throw new ApiException(ErrorCode.ResourceNotFound);
      }
      const sourceId = assets[0]?.costCenterId;
      if (!sourceId) {
        throw new ApiException(ErrorCode.ResourceNotFound);
      }
      if (assets.some((item) => item.costCenterId !== sourceId)) {
        throw new ApiException(ErrorCode.ValidationFailed);
      }
      if (sourceId === dto.targetCostCenterId) {
        throw new ApiException(ErrorCode.LoanSameCostCenter);
      }
      const target = await manager.findOne(CostCenter, {
        where: { id: dto.targetCostCenterId, isActive: true },
      });
      if (!target) {
        throw new ApiException(ErrorCode.ResourceNotFound);
      }
      const contact = await manager.findOne(Person, { where: { id: dto.contactPerson } });
      if (!contact) {
        throw new ApiException(ErrorCode.ResourceNotFound);
      }
      for (const asset of assets) {
        if (!LOANABLE.includes(asset.operationalStatus)) {
          throw new ApiException(ErrorCode.AssetCannotBeModified);
        }
      }
      const busy = (await manager.query(
        `SELECT DISTINCT i.asset_id FROM asset_loan_item i JOIN asset_loan l ON l.id = i.loan_id
         WHERE i.asset_id = ANY($1) AND l.status::text = ANY($2) AND i.received_at IS NULL`,
        [uniqueIds, OPEN_LOAN_STATUSES],
      )) as Array<{ asset_id: string }>;
      if (busy.length > 0) {
        throw new ApiException(
          ErrorCode.AssetAlreadyLoaned,
          undefined,
          busy.map((row) => ({ field: 'assets', message: `El activo ${row.asset_id} ya está en un préstamo abierto` })),
        );
      }
      const now = new Date();
      const created = manager.create(AssetLoan, {
        sourceCostCenterId: sourceId,
        targetCostCenterId: dto.targetCostCenterId,
        targetLocationId: dto.targetLocationId ?? null,
        contactPersonId: dto.contactPerson,
        requestedAt: now,
        expectedReturnDate: dto.expectedReturnDate.slice(0, 10),
        requestedBy: actor.id,
        status: 'REQUESTED',
        justification: dto.justification,
        deliveryNotes: dto.deliveryNotes ?? null,
        createdAt: now,
        updatedAt: now,
      });
      const saved = await manager.save(created);
      for (const asset of assets) {
        await manager.save(
          manager.create(AssetLoanItem, {
            loanId: saved.id,
            assetId: asset.id,
            sourceCostCenterId: sourceId,
            statusOnLoan: asset.operationalStatus,
            conditionOnDelivery: asset.physicalCondition,
          }),
        );
      }
      await this.addEvent(manager, saved.id, 'REQUESTED', actor.id, { assets: uniqueIds });
      await this.audit(manager, AuditAction.LoanRequested, saved.id, actor.id, { assets: uniqueIds });
      return saved.id;
    });
    return this.detailById(loanId);
  }

  /**
   * Aprueba con loan:approve:global, o con loan:approve:org_unit sobre el centro de costo de ORIGEN del préstamo
   * (PermissionsService.costCenterScope, misma semántica que la lectura de activos). Quien solicita no aprueba.
   */
  async approve(id: string, actor: AuthenticatedUser) {
    const scope = requireApprovalScope(
      await this.permissions.costCenterScope(actor.id, LOAN_APPROVE_GLOBAL, LOAN_APPROVE_SCOPED),
    );
    await this.dataSource.transaction(async (manager) => {
      const loan = await this.lockLoan(manager, id);
      assertLoanInApprovalScope(scope, loan.sourceCostCenterId);
      if (loan.requestedBy === actor.id) {
        throw new ApiException(ErrorCode.LoanSodViolation);
      }
      assertLoanTransition(loan.status, 'APPROVED');
      const now = new Date();
      await manager.update(AssetLoan, loan.id, {
        status: 'APPROVED',
        approvedAt: now,
        approvedBy: actor.id,
        updatedAt: now,
      });
      await this.addEvent(manager, loan.id, 'APPROVED', actor.id, {});
      await this.audit(manager, AuditAction.LoanApproved, loan.id, actor.id);
    });
    return this.detailById(id);
  }

  async reject(id: string, dto: RejectLoanDto, actor: AuthenticatedUser) {
    const scope = requireApprovalScope(
      await this.permissions.costCenterScope(actor.id, LOAN_APPROVE_GLOBAL, LOAN_APPROVE_SCOPED),
    );
    await this.dataSource.transaction(async (manager) => {
      const loan = await this.lockLoan(manager, id);
      assertLoanInApprovalScope(scope, loan.sourceCostCenterId);
      if (loan.requestedBy === actor.id) {
        throw new ApiException(ErrorCode.LoanSodViolation);
      }
      assertLoanTransition(loan.status, 'REJECTED');
      await manager.update(AssetLoan, loan.id, {
        status: 'REJECTED',
        rejectedReason: dto.reason,
        updatedAt: new Date(),
      });
      await this.addEvent(manager, loan.id, 'REJECTED', actor.id, { reason: dto.reason });
      await this.audit(manager, AuditAction.LoanRejected, loan.id, actor.id, { reason: dto.reason });
    });
    return this.detailById(id);
  }

  /**
   * Entrega física, en UNA transacción con la fila del préstamo bloqueada: cada activo pasa a ON_LOAN con su
   * movimiento LOAN fechado en la entrega (los activos salieron: la trazabilidad registra el hecho cuando ocurre),
   * el préstamo queda PENDING_SIGNATURES y se encola el acta OCI-01-65 en el outbox del motor. El préstamo pasa a
   * ACTIVE cuando el acta queda firmada (LoanDeliveryActLifecycle.onSigned). Si la generación falla, deliveryAct la
   * muestra FAILED con su error (se reintenta con POST /documents/requests/:requestId/retry).
   */
  async deliver(id: string, dto: DeliverLoanDto, actor: AuthenticatedUser) {
    await this.dataSource.transaction(async (manager) => {
      const loan = await this.lockLoan(manager, id);
      assertLoanTransition(loan.status, 'PENDING_SIGNATURES');
      const contactPersonId = loan.contactPersonId;
      if (!contactPersonId) {
        throw new ApiException(
          ErrorCode.ValidationFailed,
          'El préstamo no tiene persona de contacto: el acta OCI-01-65 necesita quién recibe',
        );
      }
      await this.requirePersons(manager, [dto.deliveredByPersonId, dto.controlInternoPersonId]);

      const deliveredAt = new Date();
      const deliveryDay = bogotaDate(deliveredAt);
      const estimated = usageBetween(deliveryDay, loan.expectedReturnDate);
      if (!estimated) {
        throw new ApiException(
          ErrorCode.ValidationFailed,
          `La fecha estimada de devolución (${loan.expectedReturnDate}) es anterior a la entrega (${deliveryDay})`,
        );
      }

      const items = (await manager.query(
        `SELECT i.id, i.asset_id FROM asset_loan_item i JOIN asset a ON a.id = i.asset_id
         WHERE i.loan_id = $1 ORDER BY a.internal_code, i.id`,
        [loan.id],
      )) as Array<{ id: string; asset_id: string }>;
      if (items.length === 0) {
        throw new ApiException(ErrorCode.InvalidState, 'El préstamo no tiene activos');
      }
      const assetIds = items.map((item) => item.asset_id);
      const assetNotes = dto.assetNotes ?? {};
      const foreign = Object.keys(assetNotes).filter((assetId) => !assetIds.includes(assetId));
      if (foreign.length > 0 || Object.values(assetNotes).some((note) => typeof note !== 'string')) {
        throw new ApiException(
          ErrorCode.ValidationFailed,
          `assetNotes solo admite texto para activos del préstamo${foreign.length ? `: ${foreign.join(', ')}` : ''}`,
        );
      }

      const movementIds: Record<string, string> = {};
      for (const item of items) {
        await this.assetState.apply(
          {
            assetId: item.asset_id,
            actorId: actor.id,
            // Solo el estado operativo: el responsable y el centro de costo del activo no cambian en un préstamo.
            patch: { operationalStatus: OperationalStatus.OnLoan },
            movement: {
              type: MovementType.Loan,
              reason: loan.justification,
              documentReference: null,
              executedAt: deliveredAt,
              requestedBy: loan.requestedBy,
              // AssetStateService no pasa loanId a asset_movement.loan_id: el vínculo queda en metadata.
              metadata: {
                loanId: loan.id,
                targetCostCenterId: loan.targetCostCenterId,
                targetLocationId: loan.targetLocationId,
                contactPersonId,
              },
            },
            guard: (current) => {
              if (current.costCenterId !== loan.sourceCostCenterId) {
                throw new ApiException(
                  ErrorCode.AssetCannotBeModified,
                  `El activo ${current.internalCode} ya no pertenece al centro de costo de origen del préstamo`,
                );
              }
              if (!LOANABLE.includes(current.operationalStatus)) {
                throw new ApiException(
                  ErrorCode.AssetCannotBeModified,
                  `El activo ${current.internalCode} está ${current.operationalStatus}: no se puede entregar en préstamo`,
                );
              }
            },
            alsoWrite: (writer, current) =>
              writer
                .update(AssetLoanItem, item.id, {
                  statusOnLoan: current.operationalStatus,
                  conditionOnDelivery: current.physicalCondition,
                })
                .then(() => undefined),
          },
          manager,
        );
        movementIds[item.asset_id] = await this.lastMovementId(manager, item.asset_id);
      }

      await manager.update(AssetLoan, loan.id, {
        status: 'PENDING_SIGNATURES',
        deliveredAt,
        deliveredBy: actor.id,
        updatedAt: deliveredAt,
      });

      const signers = { ENTREGA: dto.deliveredByPersonId, AUDITA: dto.controlInternoPersonId };
      const fields = {
        fechaEntrega: longSpanishDate(deliveryDay),
        fechaEstimadaDevolucion: longSpanishDate(loan.expectedReturnDate),
        tiempoUso: estimated.text,
      };
      const requestId = await this.documents.enqueue(
        manager,
        {
          formatKey: LOAN_DELIVERY_FORMAT,
          entityType: LOAN_DOCUMENT_ENTITY,
          entityId: loan.id,
          // Centro de ORIGEN: en el acta firmada de ejemplo firma como Entrega el jefe de ese centro.
          costCenterId: loan.sourceCostCenterId,
          responsiblePersonId: contactPersonId,
          assetIds,
          movementIds,
          signers,
          ...(Object.keys(assetNotes).length ? { assetNotes } : {}),
          fields,
        },
        actor.id,
      );
      await this.addEvent(manager, loan.id, 'DELIVERED', actor.id, {
        documentRequestId: requestId,
        movementIds,
        signers: { ...signers, RECIBE: contactPersonId },
        fields,
      });
      await this.audit(manager, AuditAction.LoanDelivered, loan.id, actor.id, { documentRequestId: requestId });
    });
    return this.detailById(id);
  }

  /**
   * Nueva acta OCI-01-65 cuando la vigente fue RECHAZADA, con el préstamo PENDING_SIGNATURES. En una transacción:
   * encola otra solicitud (el acta nueva tendrá otro consecutivo) con los mismos activos, movimientos LOAN, notas y
   * fechas de la entrega, y los firmantes corregidos; la rechazada queda como registro REJECTED. El enlace
   * movimiento ↔ acta es único (uq_document_asset_movement): pasa del acta rechazada a la nueva.
   * Permiso: el de generación del formato (loan:update:global).
   */
  async regenerateDeliveryAct(id: string, dto: RegenerateDeliveryActDto, actor: AuthenticatedUser) {
    const { format } = this.documents.formatReadiness(LOAN_DELIVERY_FORMAT);
    if (!(await this.permissions.userHasPermission(actor.id, format.generatePermission))) {
      throw new ApiException(ErrorCode.InsufficientPermissions, `Requiere permiso ${format.generatePermission}`);
    }
    await this.dataSource.transaction(async (manager) => {
      const loan = await this.lockLoan(manager, id);
      if (loan.status !== 'PENDING_SIGNATURES') {
        throw new ApiException(ErrorCode.InvalidLoanStateTransition);
      }
      const act = await this.deliveryAct(loan, manager);
      if (act.status !== 'REJECTED' || !act.documentId) {
        throw new ApiException(ErrorCode.LoanDeliveryActNotRejected, `El acta de entrega está ${act.status}`);
      }
      const [previousRequest] = (await manager.query(
        `SELECT payload FROM document_request
         WHERE format_key = $1 AND payload->>'entityType' = $2 AND payload->>'entityId' = $3
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        [LOAN_DELIVERY_FORMAT, LOAN_DOCUMENT_ENTITY, loan.id],
      )) as Array<{ payload: DocumentRequestPayload }>;
      if (!previousRequest) {
        throw new ApiException(ErrorCode.InvalidState, 'No se encontró la solicitud del acta de entrega original');
      }
      const contactPersonId = dto.contactPersonId ?? loan.contactPersonId;
      if (!contactPersonId) {
        throw new ApiException(ErrorCode.ValidationFailed, 'El acta necesita la persona de contacto que firma RECIBE');
      }
      await this.requirePersons(manager, [dto.deliveredByPersonId, dto.controlInternoPersonId, contactPersonId]);
      if (contactPersonId !== loan.contactPersonId) {
        await manager.update(AssetLoan, loan.id, { contactPersonId, updatedAt: new Date() });
      }
      await manager.query('UPDATE document_asset SET movement_id = NULL WHERE document_id = $1', [act.documentId]);
      const signers = { ENTREGA: dto.deliveredByPersonId, AUDITA: dto.controlInternoPersonId };
      const payload: DocumentRequestPayload = {
        ...previousRequest.payload,
        formatKey: LOAN_DELIVERY_FORMAT,
        entityType: LOAN_DOCUMENT_ENTITY,
        entityId: loan.id,
        costCenterId: loan.sourceCostCenterId,
        responsiblePersonId: contactPersonId,
        signers,
      };
      const requestId = await this.documents.enqueue(manager, payload, actor.id);
      await this.addEvent(manager, loan.id, 'DELIVERY_ACT_REGENERATED', actor.id, {
        documentRequestId: requestId,
        previousDocumentId: act.documentId,
        previousNumber: act.number,
        signers: { ...signers, RECIBE: contactPersonId },
        ...(contactPersonId !== loan.contactPersonId ? { previousContactPersonId: loan.contactPersonId } : {}),
        reason: dto.reason,
      });
      await this.audit(manager, AuditAction.LoanDeliveryActRegenerated, loan.id, actor.id, {
        documentRequestId: requestId,
        previousDocumentId: act.documentId,
        reason: dto.reason,
      });
    });
    return this.detailById(id);
  }

  /**
   * Deshace la entrega de un préstamo PENDING_SIGNATURES que no va a seguir, en UNA transacción: anula el acta
   * pendiente (voidForEntity: solicitudes → CANCELLED, acta PENDING_SIGNATURE → VOIDED; nunca una firmada), cada
   * activo vuelve a su estado previo con un movimiento RETURN trazable (metadata.undoDelivery) y el préstamo queda
   * CANCELLED. Quién y cuándo puede hacerlo no está definido: se exige el permiso de generación del acta
   * (loan:update:global) y es una pregunta abierta para Control Interno (docs/decisiones.md).
   * Orden de bloqueos: primero el acta (voidForEntity) y después el préstamo, el mismo orden que la generación
   * (fila del outbox → onGenerated bloquea el préstamo), para no cruzarse con el job.
   */
  async undoDelivery(id: string, dto: UndoDeliveryDto, actor: AuthenticatedUser) {
    const { format } = this.documents.formatReadiness(LOAN_DELIVERY_FORMAT);
    if (!(await this.permissions.userHasPermission(actor.id, format.generatePermission))) {
      throw new ApiException(ErrorCode.InsufficientPermissions, `Requiere permiso ${format.generatePermission}`);
    }
    const reason = dto.reason.trim();
    await this.dataSource.transaction(async (manager) => {
      const exists = await manager.findOne(AssetLoan, { where: { id } });
      if (!exists) {
        throw new ApiException(ErrorCode.ResourceNotFound);
      }
      const voided = await this.documents.voidForEntity(manager, {
        entityType: LOAN_DOCUMENT_ENTITY,
        entityId: id,
        reason,
        actorId: actor.id,
      });
      const loan = await this.lockLoan(manager, id);
      if (loan.status !== 'PENDING_SIGNATURES') {
        throw new ApiException(ErrorCode.InvalidLoanStateTransition);
      }
      assertLoanTransition(loan.status, 'CANCELLED');
      const items = await manager.find(AssetLoanItem, { where: { loanId: id }, order: { assetId: 'ASC' } });
      const now = new Date();
      const movementIds: Record<string, string> = {};
      for (const item of items) {
        await this.assetState.apply(
          {
            assetId: item.assetId,
            actorId: actor.id,
            patch: { operationalStatus: item.statusOnLoan ?? OperationalStatus.InUse },
            movement: {
              type: MovementType.Return,
              reason: `Entrega del préstamo deshecha: ${reason}`,
              documentReference: null,
              executedAt: now,
              metadata: { loanId: loan.id, undoDelivery: true, voidedDocumentIds: voided.voidedDocumentIds },
            },
            guard: (current) => {
              if (current.operationalStatus !== OperationalStatus.OnLoan) {
                throw new ApiException(
                  ErrorCode.InvalidState,
                  `El activo ${current.internalCode} no está ON_LOAN (${current.operationalStatus})`,
                );
              }
            },
          },
          manager,
        );
        movementIds[item.assetId] = await this.lastMovementId(manager, item.assetId);
      }
      await manager.update(AssetLoan, loan.id, { status: 'CANCELLED', updatedAt: now });
      await this.addEvent(manager, loan.id, 'DELIVERY_UNDONE', actor.id, {
        reason,
        movementIds,
        cancelledRequestIds: voided.cancelledRequestIds,
        voidedDocumentIds: voided.voidedDocumentIds,
      });
      await this.audit(manager, AuditAction.LoanDeliveryUndone, loan.id, actor.id, {
        reason,
        voidedDocumentIds: voided.voidedDocumentIds,
      });
    });
    return this.detailById(id);
  }

  /**
   * Registra la devolución (fecha real y condición por activo). Desde ACTIVE/OVERDUE, o desde PARTIALLY_RETURNED
   * para los activos que siguían fuera (devolverlos después o declararlos perdidos con LOST). Un activo ya recibido
   * no se vuelve a registrar.
   */
  async startReturn(id: string, dto: ReturnLoanDto, actor: AuthenticatedUser) {
    await this.dataSource.transaction(async (manager) => {
      const loan = await this.lockLoan(manager, id);
      assertLoanTransition(loan.status, 'PENDING_RECEPTION');
      const items = await manager.find(AssetLoanItem, { where: { loanId: id } });
      const byAsset = new Map(items.map((item) => [item.assetId, item]));
      const seen = new Set<string>();
      const now = new Date();
      const recorded: Array<{ assetId: string; condition: string; returnedAt: string }> = [];
      for (const returned of dto.assetsReturned) {
        if (seen.has(returned.assetId)) {
          throw new ApiException(ErrorCode.ValidationFailed, `El activo ${returned.assetId} está repetido`);
        }
        seen.add(returned.assetId);
        const item = byAsset.get(returned.assetId);
        if (!item) {
          throw new ApiException(ErrorCode.ResourceNotFound, `El activo ${returned.assetId} no está en el préstamo`);
        }
        if (item.receivedAt) {
          throw new ApiException(ErrorCode.ValidationFailed, `El activo ${returned.assetId} ya se recibió de vuelta`);
        }
        const returnedAt = returned.returnedAt ? new Date(returned.returnedAt) : now;
        if (returnedAt.getTime() > now.getTime()) {
          throw new ApiException(ErrorCode.ValidationFailed, 'La fecha real de devolución no puede ser futura');
        }
        if (loan.deliveredAt && returnedAt.getTime() < loan.deliveredAt.getTime()) {
          throw new ApiException(
            ErrorCode.ValidationFailed,
            'La fecha real de devolución no puede ser anterior a la entrega',
          );
        }
        await manager.update(AssetLoanItem, item.id, {
          returnCondition: returned.condition,
          returnedAt,
        });
        recorded.push({ assetId: returned.assetId, condition: returned.condition, returnedAt: returnedAt.toISOString() });
      }
      await manager.update(AssetLoan, loan.id, {
        status: 'PENDING_RECEPTION',
        returnNotes: dto.notes ?? loan.returnNotes ?? null,
        updatedAt: now,
      });
      await this.addEvent(manager, loan.id, 'RETURN_STARTED', actor.id, {
        assets: recorded,
        notes: dto.notes ?? null,
      });
    });
    return this.detailById(id);
  }

  /**
   * Recepción de la devolución, en UNA transacción: cada activo registrado y aún no recibido sale de ON_LOAN con su
   * movimiento RETURN (fecha del movimiento = fecha real de devolución) y queda recibido (received_at). Mapeo de
   * condición heredado: GOOD conserva la condición, DAMAGED la deja FAIR y LOST marca el activo LOST sin tocar la
   * condición (pregunta abierta para Control Interno). Estado: statusAfterReception.
   * Acta de devolución (LOAN_RETURN): si el formato está listo se encola aquí, con cada activo enlazado a su
   * movimiento RETURN; si no (hoy: sin código SGC ni firmantes) la recepción se registra igual y el evento RECEIVED
   * guarda returnAct.status = PENDING_FORMAT.
   */
  async receiveReturn(id: string, dto: ReceiveReturnDto, actor: AuthenticatedUser) {
    const readiness = this.documents.formatReadiness(LOAN_RETURN_FORMAT);
    await this.dataSource.transaction(async (manager) => {
      const loan = await this.lockLoan(manager, id);
      if (loan.status !== 'PENDING_RECEPTION') {
        throw new ApiException(ErrorCode.InvalidLoanStateTransition);
      }
      const returnSigners = readiness.ready ? await this.returnActSigners(manager, readiness.format.signers, dto, loan) : null;
      const items = await manager.find(AssetLoanItem, { where: { loanId: id } });
      const now = new Date();
      const movementIds: Record<string, string> = {};
      const received: AssetLoanItem[] = [];
      let lastReturn: Date | null = loan.actualReturnDate;
      for (const item of items) {
        if (!item.returnCondition || item.receivedAt) {
          continue;
        }
        const lost = item.returnCondition === 'LOST';
        const patch: UpdateAssetRecord = lost
          ? { operationalStatus: OperationalStatus.Lost }
          : {
              operationalStatus: item.statusOnLoan ?? OperationalStatus.InUse,
              ...(item.returnCondition === 'DAMAGED' ? { physicalCondition: PhysicalCondition.Fair } : {}),
            };
        const returnedAt = item.returnedAt ?? now;
        await this.assetState.apply(
          {
            assetId: item.assetId,
            actorId: actor.id,
            patch,
            movement: {
              type: MovementType.Return,
              reason: loan.returnNotes,
              documentReference: null,
              executedAt: returnedAt,
              metadata: { loanId: loan.id, returnCondition: item.returnCondition },
            },
            guard: (current) => {
              if (current.operationalStatus !== OperationalStatus.OnLoan) {
                throw new ApiException(
                  ErrorCode.InvalidState,
                  `El activo ${current.internalCode} no está ON_LOAN (${current.operationalStatus})`,
                );
              }
            },
          },
          manager,
        );
        movementIds[item.assetId] = await this.lastMovementId(manager, item.assetId);
        await manager.update(AssetLoanItem, item.id, { receivedAt: now });
        item.receivedAt = now;
        received.push(item);
        if (!lastReturn || returnedAt > lastReturn) {
          lastReturn = returnedAt;
        }
      }
      if (received.length === 0) {
        throw new ApiException(ErrorCode.InvalidState, 'No hay activos con devolución registrada pendientes de recibir');
      }
      const status: LoanStatus = statusAfterReception(
        items.map((item) => ({ received: item.receivedAt !== null, lost: item.returnCondition === 'LOST' })),
      );
      assertLoanTransition(loan.status, status);
      await manager.update(AssetLoan, loan.id, {
        status,
        actualReturnDate: lastReturn ?? now,
        receivedBackBy: actor.id,
        updatedAt: now,
      });

      let returnAct: ReturnActEventPayload;
      if (returnSigners) {
        const requestId = await this.documents.enqueue(
          manager,
          await this.returnActPayload(manager, loan, received, items, movementIds, returnSigners, lastReturn ?? now, now),
          actor.id,
        );
        returnAct = { status: 'REQUESTED', documentRequestId: requestId };
      } else {
        returnAct = { status: 'PENDING_FORMAT', reasons: readiness.reasons };
      }
      await this.addEvent(manager, loan.id, 'RECEIVED', actor.id, {
        status,
        movementIds,
        assets: received.map((item) => item.assetId),
        returnAct,
      });
      await this.audit(manager, AuditAction.LoanReturned, loan.id, actor.id, { status });
    });
    return this.detailById(id);
  }

  /** Firmantes REQUEST del acta de devolución según el catálogo; RESPONSIBLE es la persona de contacto. */
  private async returnActSigners(
    manager: EntityManager,
    specs: ReadonlyArray<{ readonly role: string; readonly source: 'RESPONSIBLE' | 'REQUEST' }>,
    dto: ReceiveReturnDto,
    loan: AssetLoan,
  ): Promise<Record<string, string>> {
    const roles = specs.filter((spec) => spec.source === 'REQUEST').map((spec) => spec.role);
    const given = dto.returnActSigners ?? {};
    const missing = roles.filter((role) => !given[role]);
    const unknown = Object.keys(given).filter((role) => !roles.includes(role));
    const invalid = Object.entries(given).filter(([, personId]) => typeof personId !== 'string' || !UUID.test(personId));
    if (missing.length > 0 || unknown.length > 0 || invalid.length > 0) {
      throw new ApiException(ErrorCode.ValidationFailed, 'Firmantes del acta de devolución inválidos', [
        ...missing.map((role) => ({ field: 'returnActSigners', message: `Falta el firmante ${role}` })),
        ...unknown.map((role) => ({ field: 'returnActSigners', message: `El acta de devolución no tiene el rol ${role}` })),
        ...invalid.map(([role]) => ({ field: 'returnActSigners', message: `El firmante ${role} no es un uuid` })),
      ]);
    }
    if (specs.some((spec) => spec.source === 'RESPONSIBLE') && !loan.contactPersonId) {
      throw new ApiException(ErrorCode.ValidationFailed, 'El acta de devolución necesita la persona de contacto del préstamo');
    }
    const signers = Object.fromEntries(roles.map((role) => [role, given[role] as string]));
    await this.requirePersons(manager, Object.values(signers));
    return signers;
  }

  /** Solicitud del acta LOAN_RETURN: contrato de marcadores en documents/domain/document-formats.ts. */
  private async returnActPayload(
    manager: EntityManager,
    loan: AssetLoan,
    received: ReadonlyArray<AssetLoanItem>,
    items: ReadonlyArray<AssetLoanItem>,
    movementIds: Record<string, string>,
    signers: Record<string, string>,
    lastReturn: Date,
    receivedAt: Date,
  ): Promise<DocumentRequestPayload> {
    const [target] = (await manager.query('SELECT external_code, name FROM cost_center WHERE id = $1', [
      loan.targetCostCenterId,
    ])) as Array<{ external_code: string; name: string }>;
    const [deliveryAct] = loan.deliveryDocumentId
      ? ((await manager.query(`SELECT number FROM document WHERE id = $1 AND status = 'SIGNED'`, [
          loan.deliveryDocumentId,
        ])) as Array<{ number: string }>)
      : [];
    const deliveryDay = loan.deliveredAt ? bogotaDate(loan.deliveredAt) : null;
    const returnDay = bogotaDate(lastReturn);
    const count = (condition: LoanReturnCondition | null) => received.filter((item) => item.returnCondition === condition).length;
    return {
      formatKey: LOAN_RETURN_FORMAT,
      entityType: LOAN_DOCUMENT_ENTITY,
      entityId: loan.id,
      costCenterId: loan.sourceCostCenterId,
      ...(loan.contactPersonId ? { responsiblePersonId: loan.contactPersonId } : {}),
      assetIds: received.map((item) => item.assetId),
      movementIds,
      signers,
      fields: {
        fechaDevolucion: longSpanishDate(returnDay),
        fechaRecepcion: longSpanishDate(bogotaDate(receivedAt)),
        fechaEntrega: deliveryDay ? longSpanishDate(deliveryDay) : '',
        fechaEstimadaDevolucion: longSpanishDate(loan.expectedReturnDate),
        tiempoUsoReal: deliveryDay ? (usageBetween(deliveryDay, returnDay)?.text ?? '') : '',
        actaEntregaCodigo: LOAN_DELIVERY_FORMAT,
        actaEntregaNumero: deliveryAct?.number ?? '',
        centroDestinoCodigo: target?.external_code ?? '',
        centroDestinoNombre: target?.name ?? '',
        observaciones: loan.returnNotes ?? '',
        totalDevueltos: String(count('GOOD') + count('DAMAGED')),
        totalPerdidos: String(count('LOST')),
        totalPendientes: String(items.filter((item) => item.receivedAt === null).length),
      },
      assetFields: Object.fromEntries(
        received.map((item) => [
          item.assetId,
          {
            condicionDevolucion: item.returnCondition ? RETURN_CONDITION_LABELS[item.returnCondition] : '',
            fechaDevolucion: item.returnedAt ? longSpanishDate(bogotaDate(item.returnedAt)) : '',
            estadoEntrega: item.conditionOnDelivery
              ? (PHYSICAL_CONDITION_LABELS[item.conditionOnDelivery] ?? item.conditionOnDelivery)
              : 'Sin verificar',
          },
        ]),
      ),
    };
  }

  /**
   * Pedir extensión: solo quien solicitó el préstamo (loan:request:own), con el préstamo ACTIVE u OVERDUE y una
   * fecha posterior a la vigente y no pasada. Queda pendiente (extensionRequestedDate) hasta que la apruebe quien
   * puede aprobar el préstamo.
   */
  async requestExtension(id: string, dto: ExtendLoanDto, actor: AuthenticatedUser) {
    await this.dataSource.transaction(async (manager) => {
      const loan = await this.lockLoan(manager, id);
      if (loan.requestedBy !== actor.id) {
        throw new ApiException(ErrorCode.LoanExtensionNotRequester);
      }
      if (loan.status !== 'ACTIVE' && loan.status !== 'OVERDUE') {
        throw new ApiException(ErrorCode.InvalidLoanStateTransition);
      }
      const requested = dto.expectedReturnDate.slice(0, 10);
      if (requested <= loan.expectedReturnDate || requested < bogotaDate(new Date())) {
        throw new ApiException(
          ErrorCode.ValidationFailed,
          `La nueva fecha (${requested}) debe ser posterior a la vigente (${loan.expectedReturnDate}) y no pasada`,
        );
      }
      await manager.update(AssetLoan, loan.id, {
        extensionRequestedDate: requested,
        updatedAt: new Date(),
      });
      await this.addEvent(manager, loan.id, 'EXTENSION_REQUESTED', actor.id, {
        expectedReturnDate: requested,
        reason: dto.reason,
      });
    });
    return this.detailById(id);
  }

  /**
   * Aprobar la extensión pedida: loan:approve:global o loan:approve:org_unit sobre el centro de ORIGEN (mismo
   * alcance y respuestas que aprobar el préstamo); quien la pidió (el solicitante) no la aprueba. Un OVERDUE cuya
   * nueva fecha no está vencida vuelve a ACTIVE.
   */
  async approveExtension(id: string, actor: AuthenticatedUser) {
    const scope = requireApprovalScope(
      await this.permissions.costCenterScope(actor.id, LOAN_APPROVE_GLOBAL, LOAN_APPROVE_SCOPED),
    );
    await this.dataSource.transaction(async (manager) => {
      const loan = await this.lockLoan(manager, id);
      assertLoanInApprovalScope(scope, loan.sourceCostCenterId);
      if (loan.requestedBy === actor.id) {
        throw new ApiException(ErrorCode.LoanSodViolation);
      }
      if (loan.status !== 'ACTIVE' && loan.status !== 'OVERDUE') {
        throw new ApiException(ErrorCode.InvalidLoanStateTransition);
      }
      const requested = loan.extensionRequestedDate;
      if (!requested) {
        throw new ApiException(ErrorCode.LoanNoPendingExtension);
      }
      const reopened = loan.status === 'OVERDUE' && requested >= bogotaDate(new Date());
      if (reopened) {
        assertLoanTransition(loan.status, 'ACTIVE');
      }
      await manager.update(AssetLoan, loan.id, {
        expectedReturnDate: requested,
        extensionRequestedDate: null,
        ...(reopened ? { status: 'ACTIVE' as const } : {}),
        updatedAt: new Date(),
      });
      await this.addEvent(manager, loan.id, 'EXTENDED', actor.id, {
        expectedReturnDate: requested,
        previousExpectedReturnDate: loan.expectedReturnDate,
      });
      await this.audit(manager, AuditAction.LoanExtended, loan.id, actor.id, {
        expectedReturnDate: { from: loan.expectedReturnDate, to: requested },
      });
    });
    return this.detailById(id);
  }

  /** Rechazar la extensión pedida: mismo permiso, alcance y separación de funciones que aprobarla. */
  async rejectExtension(id: string, dto: RejectLoanDto, actor: AuthenticatedUser) {
    const scope = requireApprovalScope(
      await this.permissions.costCenterScope(actor.id, LOAN_APPROVE_GLOBAL, LOAN_APPROVE_SCOPED),
    );
    await this.dataSource.transaction(async (manager) => {
      const loan = await this.lockLoan(manager, id);
      assertLoanInApprovalScope(scope, loan.sourceCostCenterId);
      if (loan.requestedBy === actor.id) {
        throw new ApiException(ErrorCode.LoanSodViolation);
      }
      if (!loan.extensionRequestedDate) {
        throw new ApiException(ErrorCode.LoanNoPendingExtension);
      }
      await manager.update(AssetLoan, loan.id, { extensionRequestedDate: null, updatedAt: new Date() });
      await this.addEvent(manager, loan.id, 'EXTENSION_REJECTED', actor.id, {
        expectedReturnDate: loan.extensionRequestedDate,
        reason: dto.reason,
      });
      await this.audit(manager, AuditAction.LoanExtensionRejected, loan.id, actor.id, {
        reason: dto.reason,
      });
    });
    return this.detailById(id);
  }

  /** Job diario: ACTIVE con la fecha estimada anterior a hoy (Bogotá) pasa a OVERDUE. Una sola tabla. */
  async markOverdue(): Promise<number> {
    const result = await this.loans
      .createQueryBuilder()
      .update()
      .set({ status: 'OVERDUE', updatedAt: new Date() })
      .where(`status = 'ACTIVE' AND expected_return_date < ${SQL_BOGOTA_TODAY}`)
      .execute();
    return result.affected ?? 0;
  }

  async countActiveByResponsibleUserId(userId: string): Promise<number> {
    const rows: unknown = await this.loans.query(
      `
      SELECT COUNT(*)::int AS count
      FROM asset_loan_item i
      JOIN asset_loan l ON l.id = i.loan_id
      JOIN asset a ON a.id = i.asset_id
      JOIN app_user u ON u.person_id = a.current_responsible_id
      WHERE u.id = $1
        AND l.status::text = ANY($2)
        AND i.received_at IS NULL
      `,
      [userId, ACTIVE_LOAN_STATUSES],
    );
    const row = Array.isArray(rows) ? rows[0] : undefined;
    return typeof row === 'object' && row !== null
      ? Number((row as { count?: number }).count ?? 0)
      : 0;
  }

  private async deliveryAct(
    loan: AssetLoan,
    manager?: EntityManager,
  ): Promise<{
    status: LoanDeliveryActStatus;
    formatKey: string;
    requestId: string | null;
    documentId: string | null;
    number: string | null;
    attempts: number;
    error: string | null;
    retryable: boolean;
    signedAt: Date | null;
    regenerable: boolean;
    previous: Array<{ documentId: string; number: string; status: string; createdAt: Date }>;
  }> {
    const state = await this.documentLifecycle.stateFor(LOAN_DOCUMENT_ENTITY, loan.id, {
      formatKey: LOAN_DELIVERY_FORMAT,
      ...(manager ? { manager } : {}),
    });
    const request = state.requests[0];
    // El outbox puede traer CANCELLED (voidForEntity) aunque el tipo del registro no lo nombre.
    const requestStatus = request?.status as string | undefined;
    const waiting = requestStatus === 'PENDING' || requestStatus === 'FAILED';
    const document = waiting
      ? undefined
      : (state.documents.find((item) => item.documentId === loan.deliveryDocumentId) ??
        (request?.documentId ? state.documents.find((item) => item.documentId === request.documentId) : undefined) ??
        state.documents[0]);
    const documentStatus = document?.status as string | undefined;
    const status: LoanDeliveryActStatus = waiting
      ? (requestStatus as 'PENDING' | 'FAILED')
      : document
        ? documentStatus === 'PENDING_SIGNATURE'
          ? 'GENERATED'
          : (documentStatus as LoanDeliveryActStatus)
        : requestStatus === 'CANCELLED'
          ? 'CANCELLED'
          : 'NONE';
    return {
      status,
      formatKey: LOAN_DELIVERY_FORMAT,
      requestId: request?.requestId ?? null,
      documentId: document?.documentId ?? null,
      number: document?.number ?? null,
      attempts: request?.attempts ?? 0,
      error: document ? document.lifecycleError : status === 'FAILED' ? (request?.lastError ?? null) : null,
      retryable: status === 'FAILED',
      signedAt: document?.signedAt ?? null,
      regenerable: status === 'REJECTED' && loan.status === 'PENDING_SIGNATURES',
      previous: state.documents
        .filter((item) => item.documentId !== document?.documentId)
        .map((item) => ({ documentId: item.documentId, number: item.number, status: item.status, createdAt: item.createdAt })),
    };
  }

  /** Un acta de devolución por recepción (evento RECEIVED), con su estado en el motor. */
  private async returnActs(loan: AssetLoan, events: ReadonlyArray<AssetLoanEvent>) {
    const receptions = events.filter((event) => event.eventType === 'RECEIVED');
    if (receptions.length === 0) {
      return [];
    }
    const state = await this.documentLifecycle.stateFor(LOAN_DOCUMENT_ENTITY, loan.id, { formatKey: LOAN_RETURN_FORMAT });
    return receptions.map((event) => {
      const payload = (event.payload ?? {}) as { assets?: string[]; returnAct?: ReturnActEventPayload };
      const act = payload.returnAct;
      const base = {
        receivedAt: event.createdAt,
        assetIds: payload.assets ?? [],
        requestId: null as string | null,
        documentId: null as string | null,
        number: null as string | null,
        attempts: 0,
        error: null as string | null,
        retryable: false,
        signedAt: null as Date | null,
      };
      const request = act?.documentRequestId
        ? state.requests.find((item) => item.requestId === act.documentRequestId)
        : undefined;
      if (!request) {
        // Recepciones anteriores a esta versión no guardaron returnAct: tampoco se generó acta.
        return {
          ...base,
          status: 'PENDING_FORMAT' as LoanReturnActStatus,
          error: act?.reasons?.length ? `Formato institucional pendiente: ${act.reasons.join('; ')}` : 'Formato institucional pendiente',
        };
      }
      const requestStatus = request.status as string;
      const document = request.documentId ? state.documents.find((item) => item.documentId === request.documentId) : undefined;
      const documentStatus = document?.status as string | undefined;
      const status: LoanReturnActStatus = document
        ? documentStatus === 'PENDING_SIGNATURE'
          ? 'GENERATED'
          : (documentStatus as LoanReturnActStatus)
        : (requestStatus as LoanReturnActStatus);
      return {
        ...base,
        status,
        requestId: request.requestId,
        documentId: document?.documentId ?? null,
        number: document?.number ?? null,
        attempts: request.attempts,
        error: document ? document.lifecycleError : status === 'FAILED' ? request.lastError : null,
        retryable: status === 'FAILED',
        signedAt: document?.signedAt ?? null,
      };
    });
  }

  private async requirePersons(manager: EntityManager, ids: ReadonlyArray<string>): Promise<void> {
    const unique = [...new Set(ids)];
    const found = (await manager.query('SELECT id FROM person WHERE id = ANY($1)', [unique])) as Array<{ id: string }>;
    const missing = unique.filter((id) => !found.some((row) => row.id === id));
    if (missing.length > 0) {
      throw new ApiException(ErrorCode.ResourceNotFound, `Personas inexistentes: ${missing.join(', ')}`);
    }
  }

  /** Movimiento que AssetStateService acaba de registrar: la cabeza de la cadena del activo (fila bloqueada). */
  private async lastMovementId(manager: EntityManager, assetId: string): Promise<string> {
    const [row] = (await manager.query(
      `SELECT m.id FROM asset_movement m
       WHERE m.asset_id = $1 AND NOT EXISTS (SELECT 1 FROM asset_movement n WHERE n.previous_movement_id = m.id)
       ORDER BY m.created_at DESC LIMIT 1`,
      [assetId],
    )) as Array<{ id: string }>;
    if (!row) {
      throw new Error(`No se encontró el movimiento recién registrado del activo ${assetId}`);
    }
    return row.id;
  }

  private async requireLoan(id: string): Promise<AssetLoan> {
    const loan = await this.loans.findOne({ where: { id } });
    if (!loan) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return loan;
  }

  /** SELECT … FOR UPDATE del préstamo: serializa entregas, devoluciones y aprobaciones concurrentes. */
  private async lockLoan(manager: EntityManager, id: string): Promise<AssetLoan> {
    const loan = await manager.findOne(AssetLoan, {
      where: { id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!loan) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    return loan;
  }

  private async addEvent(
    manager: EntityManager,
    loanId: string,
    eventType: string,
    performedBy: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await manager.save(
      manager.create(AssetLoanEvent, {
        loanId,
        eventType,
        payload,
        performedBy,
        createdAt: new Date(),
      }),
    );
  }

  private audit(
    manager: EntityManager,
    action: AuditAction,
    loanId: string,
    performedBy: string,
    changes?: Record<string, unknown>,
  ): Promise<void> {
    return this.auditLogsRepository.record(
      {
        action,
        entityType: 'LOAN',
        entityId: loanId,
        performedBy,
        ipAddress: null,
        userAgent: null,
        ...(changes ? { changes } : {}),
      },
      manager,
    );
  }

  private toSummary(loan: AssetLoan, today: string) {
    const deliveryDay = loan.deliveredAt ? bogotaDate(loan.deliveredAt) : null;
    const endDay = loan.actualReturnDate ? bogotaDate(loan.actualReturnDate) : today;
    const candidate = LOAN_OVERDUE_CANDIDATE_STATUSES.includes(loan.status);
    return {
      id: loan.id,
      status: loan.status,
      sourceCostCenterId: loan.sourceCostCenterId,
      targetCostCenterId: loan.targetCostCenterId,
      targetLocationId: loan.targetLocationId,
      contactPersonId: loan.contactPersonId,
      expectedReturnDate: loan.expectedReturnDate,
      justification: loan.justification,
      deliveryNotes: loan.deliveryNotes,
      returnNotes: loan.returnNotes,
      rejectedReason: loan.rejectedReason,
      requestedBy: loan.requestedBy,
      approvedBy: loan.approvedBy,
      deliveredBy: loan.deliveredBy,
      receivedBackBy: loan.receivedBackBy,
      requestedAt: loan.requestedAt,
      approvedAt: loan.approvedAt,
      deliveredAt: loan.deliveredAt,
      actualReturnDate: loan.actualReturnDate,
      extensionRequestedDate: loan.extensionRequestedDate,
      deliveryDocumentId: loan.deliveryDocumentId,
      estimatedUsage: deliveryDay ? usageBetween(deliveryDay, loan.expectedReturnDate) : null,
      actualUsage: deliveryDay ? usageBetween(deliveryDay, endDay) : null,
      daysOverdue: candidate ? daysOverdue(loan.expectedReturnDate, today) : null,
      createdAt: loan.createdAt,
      updatedAt: loan.updatedAt,
    };
  }
}
