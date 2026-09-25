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
import { DocumentEngineService } from '../../documents/services/document-engine.service.js';
import { PermissionsService } from '../../roles/services/permissions.service.js';
import {
  assertLoanInApprovalScope,
  LOAN_APPROVE_GLOBAL,
  LOAN_APPROVE_SCOPED,
  requireApprovalScope,
} from '../domain/loan-approval.js';
import {
  bogotaDate,
  daysOverdue,
  longSpanishDate,
  SQL_BOGOTA_TODAY,
  usageBetween,
} from '../domain/loan-dates.js';
import { LOAN_DELIVERY_FORMAT, LOAN_DOCUMENT_ENTITY } from '../domain/loan-documents.js';
import { assertLoanTransition } from '../domain/loan-transitions.js';
import {
  CreateLoanDto,
  DeliverLoanDto,
  ExtendLoanDto,
  QueryLoansDto,
  RejectLoanDto,
  ReturnLoanDto,
} from '../dto/loan.dto.js';
import type { LoanDeliveryActStatus } from '../dto/loan.responses.js';
import { AssetLoan } from '../entities/asset-loan.entity.js';
import {
  AssetLoanEvent,
  AssetLoanItem,
  LoanAttachment,
} from '../entities/asset-loan-item.entity.js';
import {
  LOAN_OUT_STATUSES,
  LOAN_OVERDUE_CANDIDATE_STATUSES,
  type LoanStatus,
} from '../enums/loan-status.js';

const LOANABLE: ReadonlyArray<OperationalStatus> = [
  OperationalStatus.InUse,
  OperationalStatus.InStorage,
];

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
    @InjectRepository(CostCenter)
    private readonly costCenters: Repository<CostCenter>,
    @InjectRepository(Person)
    private readonly persons: Repository<Person>,
    private readonly dataSource: DataSource,
    private readonly assetState: AssetStateService,
    private readonly documents: DocumentEngineService,
    private readonly documentLifecycle: DocumentLifecycleRegistry,
    private readonly permissions: PermissionsService,
    @Inject('AuditLogsRepository')
    private readonly auditLogsRepository: AuditLogsRepository,
  ) {}

  async list(query: QueryLoansDto) {
    const page = Number(query.page) || 1;
    const pageSize = Math.min(Number(query.pageSize) || 20, 100);
    const qb = this.loans.createQueryBuilder('l');
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
   * Alertas de vencidos: ACTIVE u OVERDUE con la fecha estimada de devolución anterior a hoy (Bogotá), aunque el
   * job diario todavía no los haya marcado OVERDUE. Filtro y días de atraso en SQL; los más atrasados primero.
   */
  async overdue() {
    const { entities, raw } = await this.loans
      .createQueryBuilder('l')
      .addSelect(`(${SQL_BOGOTA_TODAY} - l.expected_return_date)`, 'days_overdue')
      .where('l.status IN (:...candidates)', { candidates: LOAN_OVERDUE_CANDIDATE_STATUSES })
      .andWhere(`l.expected_return_date < ${SQL_BOGOTA_TODAY}`)
      .orderBy('l.expected_return_date', 'ASC')
      .addOrderBy('l.id', 'ASC')
      .getRawAndEntities<{ days_overdue: number | string }>();
    const today = bogotaDate(new Date());
    return entities.map((row, index) => ({
      ...this.toSummary(row, today),
      daysOverdue: Number(raw[index]?.days_overdue ?? 0),
    }));
  }

  async getById(id: string) {
    const loan = await this.requireLoan(id);
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
        }))
        .sort((a, b) => (a.internalCode ?? '').localeCompare(b.internalCode ?? '') || a.id.localeCompare(b.id)),
      events,
      attachments,
      deliveryAct: await this.deliveryAct(loan),
    };
  }

  async create(dto: CreateLoanDto, actor: AuthenticatedUser) {
    const uniqueIds = [...new Set(dto.assets)];
    const assets = await this.assets.find({ where: { id: In(uniqueIds) } });
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
    const target = await this.costCenters.findOne({
      where: { id: dto.targetCostCenterId, isActive: true },
    });
    if (!target) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    const contact = await this.persons.findOne({
      where: { id: dto.contactPerson },
    });
    if (!contact) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    for (const asset of assets) {
      if (!LOANABLE.includes(asset.operationalStatus)) {
        throw new ApiException(ErrorCode.AssetCannotBeModified);
      }
      const active = await this.countActiveForAsset(asset.id);
      if (active > 0) {
        throw new ApiException(ErrorCode.AssetAlreadyLoaned);
      }
    }
    const now = new Date();
    const loan = await this.dataSource.transaction(async (manager) => {
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
      return saved;
    });
    return this.getById(loan.id);
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
    return this.getById(id);
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
    return this.getById(id);
  }

  /**
   * Entrega, en UNA transacción con la fila del préstamo bloqueada: cada activo pasa a ON_LOAN con su movimiento
   * LOAN (AssetStateService), el préstamo queda ACTIVE, se registra el evento y se encola el acta OCI-01-65 en el
   * outbox del motor. La generación del acta es asíncrona: si falla, el préstamo no se toca y deliveryAct la
   * muestra FAILED con su error (se reintenta con POST /documents/requests/:requestId/retry).
   */
  async deliver(id: string, dto: DeliverLoanDto, actor: AuthenticatedUser) {
    await this.dataSource.transaction(async (manager) => {
      const loan = await this.lockLoan(manager, id);
      assertLoanTransition(loan.status, 'ACTIVE');
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
        status: 'ACTIVE',
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
    return this.getById(id);
  }

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
        returnNotes: dto.notes ?? null,
        updatedAt: now,
      });
      await this.addEvent(manager, loan.id, 'RETURN_STARTED', actor.id, {
        assets: recorded,
        notes: dto.notes ?? null,
      });
    });
    return this.getById(id);
  }

  /**
   * Recepción de la devolución, en UNA transacción: cada activo devuelto sale de ON_LOAN con su movimiento RETURN
   * (fecha del movimiento = fecha real de devolución). Mapeo de condición heredado, sin cambios: GOOD conserva la
   * condición, DAMAGED la deja FAIR y LOST marca el activo LOST sin tocar la condición (pregunta abierta para
   * Control Interno). El acta de devolución está bloqueada (ver domain/loan-documents.ts).
   */
  async receiveReturn(id: string, actor: AuthenticatedUser) {
    await this.dataSource.transaction(async (manager) => {
      const loan = await this.lockLoan(manager, id);
      assertLoanTransition(loan.status, 'RETURNED');
      const items = await manager.find(AssetLoanItem, { where: { loanId: id } });
      const now = new Date();
      const movementIds: Record<string, string> = {};
      let lostOrMissing = 0;
      let lastReturn: Date | null = null;
      for (const item of items) {
        if (!item.returnCondition) {
          lostOrMissing += 1;
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
        if (lost) {
          lostOrMissing += 1;
        }
        if (!lastReturn || returnedAt > lastReturn) {
          lastReturn = returnedAt;
        }
      }
      const status: LoanStatus = lostOrMissing > 0 ? 'PARTIALLY_RETURNED' : 'RETURNED';
      assertLoanTransition(loan.status, status);
      await manager.update(AssetLoan, loan.id, {
        status,
        actualReturnDate: lastReturn ?? now,
        receivedBackBy: actor.id,
        updatedAt: now,
      });
      await this.addEvent(manager, loan.id, 'RECEIVED', actor.id, { status, movementIds });
      await this.audit(manager, AuditAction.LoanReturned, loan.id, actor.id, { status });
    });
    return this.getById(id);
  }

  async extend(id: string, dto: ExtendLoanDto, actor: AuthenticatedUser) {
    await this.dataSource.transaction(async (manager) => {
      const loan = await this.lockLoan(manager, id);
      if (loan.status !== 'ACTIVE' && loan.status !== 'OVERDUE') {
        throw new ApiException(ErrorCode.InvalidLoanStateTransition);
      }
      const requested = dto.expectedReturnDate.slice(0, 10);
      if (actor.id === loan.requestedBy) {
        await manager.update(AssetLoan, loan.id, {
          extensionRequestedDate: requested,
          updatedAt: new Date(),
        });
        await this.addEvent(manager, loan.id, 'EXTENSION_REQUESTED', actor.id, {
          expectedReturnDate: dto.expectedReturnDate,
          reason: dto.reason,
        });
        return;
      }
      const reopened = loan.status === 'OVERDUE' && requested >= bogotaDate(new Date());
      await manager.update(AssetLoan, loan.id, {
        expectedReturnDate: requested,
        extensionRequestedDate: null,
        ...(reopened ? { status: 'ACTIVE' as const } : {}),
        updatedAt: new Date(),
      });
      await this.addEvent(manager, loan.id, 'EXTENDED', actor.id, {
        expectedReturnDate: requested,
        reason: dto.reason,
      });
      await this.audit(manager, AuditAction.LoanExtended, loan.id, actor.id);
    });
    return this.getById(id);
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
        AND l.status IN ('APPROVED','IN_TRANSIT','ACTIVE','OVERDUE','PENDING_RECEPTION')
      `,
      [userId],
    );
    const row = Array.isArray(rows) ? rows[0] : undefined;
    return typeof row === 'object' && row !== null
      ? Number((row as { count?: number }).count ?? 0)
      : 0;
  }

  private async deliveryAct(loan: AssetLoan): Promise<{
    status: LoanDeliveryActStatus;
    formatKey: string;
    requestId: string | null;
    documentId: string | null;
    number: string | null;
    attempts: number;
    error: string | null;
    retryable: boolean;
    signedAt: Date | null;
  }> {
    const state = await this.documentLifecycle.stateFor(LOAN_DOCUMENT_ENTITY, loan.id, {
      formatKey: LOAN_DELIVERY_FORMAT,
    });
    const request = state.requests[0];
    const document =
      state.documents.find((item) => item.documentId === loan.deliveryDocumentId) ??
      (request?.documentId ? state.documents.find((item) => item.documentId === request.documentId) : undefined);
    const status: LoanDeliveryActStatus = document
      ? document.status === 'PENDING_SIGNATURE'
        ? 'GENERATED'
        : document.status
      : request?.status === 'PENDING' || request?.status === 'FAILED'
        ? request.status
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
    };
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

  private async countActiveForAsset(assetId: string): Promise<number> {
    const rows: unknown = await this.loans.query(
      `
      SELECT COUNT(*)::int AS count
      FROM asset_loan_item i
      JOIN asset_loan l ON l.id = i.loan_id
      WHERE i.asset_id = $1
        AND l.status IN ('APPROVED','IN_TRANSIT','ACTIVE','OVERDUE','PENDING_RECEPTION')
      `,
      [assetId],
    );
    const row = Array.isArray(rows) ? rows[0] : undefined;
    return typeof row === 'object' && row !== null
      ? Number((row as { count?: number }).count ?? 0)
      : 0;
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
