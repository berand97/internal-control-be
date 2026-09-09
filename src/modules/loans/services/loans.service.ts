import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
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
import { CostCenter } from '../../cost-centers/entities/cost-center.entity.js';
import { DocumentTemplatesService } from '../../document-templates/services/document-templates.service.js';
import { MovementsService } from '../../movements/services/movements.service.js';
import { assertLoanTransition } from '../domain/loan-transitions.js';
import {
  CreateLoanDto,
  ExtendLoanDto,
  QueryLoansDto,
  RejectLoanDto,
  ReturnLoanDto,
} from '../dto/loan.dto.js';
import { AssetLoan } from '../entities/asset-loan.entity.js';
import {
  AssetLoanEvent,
  AssetLoanItem,
  LoanAttachment,
} from '../entities/asset-loan-item.entity.js';
import { type LoanStatus } from '../enums/loan-status.js';

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
    private readonly movementsService: MovementsService,
    private readonly templatesService: DocumentTemplatesService,
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
      qb.andWhere("l.status IN ('ACTIVE','OVERDUE') AND l.expected_return_date < CURRENT_DATE");
    }
    const total = await qb.getCount();
    const rows = await qb
      .orderBy('l.requested_at', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getMany();
    return {
      items: rows.map((row) => this.toSummary(row)),
      page,
      pageSize,
      total,
      hasNext: page * pageSize < total,
    };
  }

  async overdue() {
    const rows = await this.loans.find({
      where: { status: In(['ACTIVE', 'OVERDUE']) },
    });
    const due = rows.filter((row) => row.expectedReturnDate < todayIso());
    return due.map((row) => ({
      ...this.toSummary(row),
      daysOverdue: daysBetween(row.expectedReturnDate, todayIso()),
    }));
  }

  async getById(id: string) {
    const loan = await this.requireLoan(id);
    const items = await this.items.find({ where: { loanId: id } });
    const events = await this.events.find({
      where: { loanId: id },
      order: { createdAt: 'ASC' },
    });
    const attachments = await this.attachments.find({ where: { loanId: id } });
    return {
      ...this.toSummary(loan),
      items,
      events,
      attachments,
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
      await manager.save(
        manager.create(AssetLoanEvent, {
          loanId: saved.id,
          eventType: 'REQUESTED',
          payload: { assets: uniqueIds },
          performedBy: actor.id,
          createdAt: now,
        }),
      );
      return saved;
    });
    await this.auditLogsRepository.record({
      action: AuditAction.LoanRequested,
      entityType: 'LOAN',
      entityId: loan.id,
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
      changes: { assets: uniqueIds },
    });
    return this.getById(loan.id);
  }

  async approve(id: string, actor: AuthenticatedUser) {
    const loan = await this.requireLoan(id);
    if (loan.requestedBy === actor.id) {
      throw new ApiException(ErrorCode.LoanSodViolation);
    }
    assertLoanTransition(loan.status, 'APPROVED');
    loan.status = 'APPROVED';
    loan.approvedAt = new Date();
    loan.approvedBy = actor.id;
    loan.updatedAt = new Date();
    await this.loans.save(loan);
    await this.addEvent(loan.id, 'APPROVED', actor.id, {});
    await this.auditLogsRepository.record({
      action: AuditAction.LoanApproved,
      entityType: 'LOAN',
      entityId: loan.id,
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
    });
    return this.getById(id);
  }

  async reject(id: string, dto: RejectLoanDto, actor: AuthenticatedUser) {
    const loan = await this.requireLoan(id);
    if (loan.requestedBy === actor.id) {
      throw new ApiException(ErrorCode.LoanSodViolation);
    }
    assertLoanTransition(loan.status, 'REJECTED');
    loan.status = 'REJECTED';
    loan.rejectedReason = dto.reason;
    loan.updatedAt = new Date();
    await this.loans.save(loan);
    await this.addEvent(loan.id, 'REJECTED', actor.id, { reason: dto.reason });
    await this.auditLogsRepository.record({
      action: AuditAction.LoanRejected,
      entityType: 'LOAN',
      entityId: loan.id,
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
      changes: { reason: dto.reason },
    });
    return this.getById(id);
  }

  async deliver(id: string, actor: AuthenticatedUser) {
    const loan = await this.requireLoan(id);
    assertLoanTransition(loan.status, 'ACTIVE');
    const items = await this.items.find({ where: { loanId: id } });
    const origin = await this.costCenters.findOne({
      where: { id: loan.sourceCostCenterId },
    });
    const destination = await this.costCenters.findOne({
      where: { id: loan.targetCostCenterId },
    });
    const requester = await this.persons.findOne({
      where: { id: (await this.personIdOfUser(loan.requestedBy)) ?? '' },
    });
    const contact = await this.persons.findOne({
      where: { id: loan.contactPersonId },
    });
    for (const item of items) {
      const asset = await this.assets.findOne({ where: { id: item.assetId } });
      if (!asset) {
        continue;
      }
      await this.assets.update(asset.id, {
        operationalStatus: OperationalStatus.OnLoan,
        updatedBy: actor.id,
        updatedAt: new Date(),
      });
      await this.movementsService.record({
        assetId: asset.id,
        movementType: MovementType.Loan,
        fromCostCenterId: asset.costCenterId,
        fromLocationId: asset.locationId,
        fromResponsibleId: asset.responsibleId,
        fromOperationalStatus: asset.operationalStatus,
        fromPhysicalCondition: asset.physicalCondition,
        toCostCenterId: loan.targetCostCenterId,
        toLocationId: loan.targetLocationId,
        toResponsibleId: loan.contactPersonId,
        toOperationalStatus: OperationalStatus.OnLoan,
        toPhysicalCondition: asset.physicalCondition,
        requestedBy: loan.requestedBy,
        authorizedBy: actor.id,
        reason: loan.justification,
        documentReference: null,
        loanId: loan.id,
      });
    }
    loan.status = 'ACTIVE';
    loan.deliveredAt = new Date();
    loan.deliveredBy = actor.id;
    loan.updatedAt = new Date();
    await this.loans.save(loan);
    const generated = await this.templatesService.generate({
      documentType: 'LOAN_DELIVERY_ACT',
      entityType: 'LOAN',
      entityId: loan.id,
      actorId: actor.id,
      context: {
        'prestamo.justificacion': loan.justification,
        'prestamo.fechaEsperadaDevolucion': loan.expectedReturnDate,
        'origen.codigo': origin?.externalCode ?? '',
        'origen.nombre': origin?.name ?? '',
        'destino.codigo': destination?.externalCode ?? '',
        'destino.nombre': destination?.name ?? '',
        'solicitante.nombre': personName(requester),
        'receptor.nombre': personName(contact),
        'receptor.documento':
          contact?.documentType && contact.documentNumber
            ? `${contact.documentType} ${contact.documentNumber}`
            : '',
        'aprobador.nombre': actor.username,
      },
    });
    if (generated) {
      await this.attachments.save(
        this.attachments.create({
          loanId: loan.id,
          kind: 'DELIVERY_ACT',
          storageKey: generated.storageKey,
          fileHash: generated.fileHash,
          createdAt: new Date(),
          createdBy: actor.id,
        }),
      );
    }
    await this.addEvent(loan.id, 'DELIVERED', actor.id, {
      actNumber: generated?.actNumber ?? null,
    });
    await this.auditLogsRepository.record({
      action: AuditAction.LoanDelivered,
      entityType: 'LOAN',
      entityId: loan.id,
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
    });
    return this.getById(id);
  }

  async startReturn(id: string, dto: ReturnLoanDto, actor: AuthenticatedUser) {
    const loan = await this.requireLoan(id);
    const next: LoanStatus =
      loan.status === 'OVERDUE' ? 'PENDING_RECEPTION' : 'PENDING_RECEPTION';
    assertLoanTransition(loan.status, next);
    const items = await this.items.find({ where: { loanId: id } });
    const byAsset = new Map(items.map((item) => [item.assetId, item]));
    for (const returned of dto.assetsReturned) {
      const item = byAsset.get(returned.assetId);
      if (!item) {
        throw new ApiException(ErrorCode.ResourceNotFound);
      }
      item.returnCondition = returned.condition;
      item.returnedAt = new Date();
      await this.items.save(item);
    }
    loan.status = next;
    loan.returnNotes = dto.notes ?? null;
    loan.updatedAt = new Date();
    await this.loans.save(loan);
    await this.addEvent(loan.id, 'RETURN_STARTED', actor.id, {
      assets: dto.assetsReturned,
    });
    return this.getById(id);
  }

  async receiveReturn(id: string, actor: AuthenticatedUser) {
    const loan = await this.requireLoan(id);
    assertLoanTransition(loan.status, 'RETURNED');
    const items = await this.items.find({ where: { loanId: id } });
    let lostOrMissing = 0;
    for (const item of items) {
      const asset = await this.assets.findOne({ where: { id: item.assetId } });
      if (!asset) {
        continue;
      }
      if (!item.returnCondition) {
        lostOrMissing += 1;
        continue;
      }
      if (item.returnCondition === 'LOST') {
        await this.assets.update(asset.id, {
          operationalStatus: OperationalStatus.Lost,
          updatedBy: actor.id,
          updatedAt: new Date(),
        });
        lostOrMissing += 1;
      } else {
        await this.assets.update(asset.id, {
          operationalStatus: item.statusOnLoan ?? OperationalStatus.InUse,
          physicalCondition:
            item.returnCondition === 'DAMAGED'
              ? PhysicalCondition.Fair
              : asset.physicalCondition,
          updatedBy: actor.id,
          updatedAt: new Date(),
        });
      }
      await this.movementsService.record({
        assetId: asset.id,
        movementType: MovementType.Return,
        fromCostCenterId: loan.targetCostCenterId,
        fromLocationId: loan.targetLocationId,
        fromResponsibleId: loan.contactPersonId,
        fromOperationalStatus: OperationalStatus.OnLoan,
        fromPhysicalCondition: asset.physicalCondition,
        toCostCenterId: item.sourceCostCenterId,
        toLocationId: asset.locationId,
        toResponsibleId: asset.responsibleId,
        toOperationalStatus:
          item.returnCondition === 'LOST'
            ? OperationalStatus.Lost
            : (item.statusOnLoan ?? OperationalStatus.InUse),
        toPhysicalCondition: asset.physicalCondition,
        requestedBy: actor.id,
        authorizedBy: actor.id,
        reason: loan.returnNotes,
        documentReference: null,
        loanId: loan.id,
      });
    }
    loan.status = lostOrMissing > 0 ? 'PARTIALLY_RETURNED' : 'RETURNED';
    if (loan.status === 'PARTIALLY_RETURNED') {
      assertLoanTransition('PENDING_RECEPTION', 'PARTIALLY_RETURNED');
    }
    loan.actualReturnDate = new Date();
    loan.receivedBackBy = actor.id;
    loan.updatedAt = new Date();
    await this.loans.save(loan);
    await this.addEvent(loan.id, 'RECEIVED', actor.id, { status: loan.status });
    await this.auditLogsRepository.record({
      action: AuditAction.LoanReturned,
      entityType: 'LOAN',
      entityId: loan.id,
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
      changes: { status: loan.status },
    });
    return this.getById(id);
  }

  async extend(id: string, dto: ExtendLoanDto, actor: AuthenticatedUser) {
    const loan = await this.requireLoan(id);
    if (loan.status !== 'ACTIVE' && loan.status !== 'OVERDUE') {
      throw new ApiException(ErrorCode.InvalidLoanStateTransition);
    }
    if (actor.id === loan.requestedBy) {
      loan.extensionRequestedDate = dto.expectedReturnDate.slice(0, 10);
      loan.updatedAt = new Date();
      await this.loans.save(loan);
      await this.addEvent(loan.id, 'EXTENSION_REQUESTED', actor.id, {
        expectedReturnDate: dto.expectedReturnDate,
        reason: dto.reason,
      });
      return this.getById(id);
    }
    loan.expectedReturnDate = dto.expectedReturnDate.slice(0, 10);
    loan.extensionRequestedDate = null;
    if (loan.status === 'OVERDUE' && loan.expectedReturnDate >= todayIso()) {
      loan.status = 'ACTIVE';
    }
    loan.updatedAt = new Date();
    await this.loans.save(loan);
    await this.addEvent(loan.id, 'EXTENDED', actor.id, {
      expectedReturnDate: loan.expectedReturnDate,
      reason: dto.reason,
    });
    await this.auditLogsRepository.record({
      action: AuditAction.LoanExtended,
      entityType: 'LOAN',
      entityId: loan.id,
      performedBy: actor.id,
      ipAddress: null,
      userAgent: null,
    });
    return this.getById(id);
  }

  async markOverdue(): Promise<number> {
    const result = await this.loans
      .createQueryBuilder()
      .update()
      .set({ status: 'OVERDUE', updatedAt: new Date() })
      .where("status = 'ACTIVE' AND expected_return_date < CURRENT_DATE")
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

  private async addEvent(
    loanId: string,
    eventType: string,
    performedBy: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.events.save(
      this.events.create({
        loanId,
        eventType,
        payload,
        performedBy,
        createdAt: new Date(),
      }),
    );
  }

  private async personIdOfUser(userId: string): Promise<string | null> {
    const rows: unknown = await this.loans.query(
      `SELECT person_id FROM app_user WHERE id = $1`,
      [userId],
    );
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (
      typeof row === 'object' &&
      row !== null &&
      typeof (row as { person_id?: unknown }).person_id === 'string'
    ) {
      return (row as { person_id: string }).person_id;
    }
    return null;
  }

  private toSummary(loan: AssetLoan) {
    return {
      id: loan.id,
      status: loan.status,
      sourceCostCenterId: loan.sourceCostCenterId,
      targetCostCenterId: loan.targetCostCenterId,
      contactPersonId: loan.contactPersonId,
      expectedReturnDate: loan.expectedReturnDate,
      justification: loan.justification,
      deliveryNotes: loan.deliveryNotes,
      requestedBy: loan.requestedBy,
      approvedBy: loan.approvedBy,
      requestedAt: loan.requestedAt,
      deliveredAt: loan.deliveredAt,
      extensionRequestedDate: loan.extensionRequestedDate,
    };
  }
}

const todayIso = (): string => new Date().toISOString().slice(0, 10);

const daysBetween = (from: string, to: string): number => {
  const ms = Date.parse(to) - Date.parse(from);
  return Math.max(0, Math.floor(ms / 86_400_000));
};

const personName = (person: Person | null): string =>
  person ? `${person.firstName} ${person.lastName}` : '';
