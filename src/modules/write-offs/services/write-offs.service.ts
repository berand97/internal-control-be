import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type EntityManager, QueryFailedError } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import {
  HOLD_OPEN_HANDOVER,
  HOLD_OPEN_INVENTORY,
  HOLD_OPEN_LOAN,
  HOLD_OPEN_TRANSFER,
  HOLD_OPEN_WRITE_OFF,
  HOLD_REQUEST_RESERVATION,
  holdReasons,
} from '../../assets/domain/asset-holds.js';
import { operationalStatusPhraseSql } from '../../assets/enums/operational-status.enum.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import { assertCostCenterHasHead, currentHeadCondition } from '../../cost-centers/domain/cost-center-head-rule.js';
import { unitAt } from '../../cost-centers/domain/placement-at.js';
import { CONTROL_SIGNER_PERMISSION } from '../../documents/domain/signer-separation.js';
import { DocumentLifecycleRegistry } from '../../documents/lifecycle/document-lifecycle.registry.js';
import { ControlSignersService } from '../../documents/services/control-signers.service.js';
import { DocumentEngineService, type DocumentRequestPayload } from '../../documents/services/document-engine.service.js';
import { OPEN_LOAN_STATUSES } from '../../loans/enums/loan-status.js';
import { costCenterFilter, type ReadableCostCenterScope, requireReadableScope } from '../../roles/services/cost-center-scope.js';
import { PermissionsService } from '../../roles/services/permissions.service.js';
import { buildWriteOffActContent } from '../domain/write-off-act.js';
import {
  ASSET_READ_GLOBAL,
  ASSET_READ_SCOPED,
  canWriteOffTransition,
  isWriteOffEditable,
  WRITE_OFF_ENTITY_TYPE,
  WRITE_OFF_FORMAT_KEY,
  WRITE_OFF_MANAGE,
  WRITE_OFF_REASON_LABELS,
  WRITE_OFF_REASONS,
  type WriteOffReason,
  type WriteOffStatus,
} from '../domain/write-off.js';
import type { CreateWriteOffDto, GenerateWriteOffActDto, QueryWriteOffsDto, UpdateWriteOffDto } from '../dto/write-off.dto.js';
import type {
  WriteOffDetailDto,
  WriteOffDocumentDto,
  WriteOffItemDto,
  WriteOffListItemDto,
  WriteOffListResponseDto,
  WriteOffReasonOptionDto,
} from '../dto/write-off.responses.js';

const AUTOMATIC_GENERATION_ATTEMPTS = 5;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PERSON_JSON = (alias: string) =>
  `CASE WHEN ${alias}.id IS NULL THEN NULL ELSE json_build_object('id', ${alias}.id,
     'name', trim(${alias}.first_name || ' ' || ${alias}.last_name), 'documentNumber', ${alias}.document_number) END`;

const USER_JSON = (user: string, person: string) =>
  `CASE WHEN ${user}.id IS NULL THEN NULL ELSE
     json_build_object('userId', ${user}.id, 'name', nullif(trim(concat_ws(' ', ${person}.first_name, ${person}.last_name)), '')) END`;

const CENTER_JSON = (alias: string) => `json_build_object('id', ${alias}.id, 'code', ${alias}.external_code, 'name', ${alias}.name)`;

const ASSET_CODE = `coalesce(
  (SELECT value FROM asset_identifier i WHERE i.asset_id = a.id AND i.identifier_type = 'VISIBLE_CODE' AND i.valid_to IS NULL LIMIT 1),
  (SELECT value FROM asset_identifier i WHERE i.asset_id = a.id AND i.identifier_type = 'LEGACY_CODE' AND i.valid_to IS NULL ORDER BY i.created_at LIMIT 1),
  a.internal_code)`;

const BLOCKERS = holdReasons(
  `CASE WHEN a.operational_status::text IN ('WRITTEN_OFF', 'ON_LOAN') THEN 'está ' || ${operationalStatusPhraseSql('a.operational_status')} END`,
  HOLD_OPEN_LOAN('$2'),
  HOLD_OPEN_TRANSFER,
  HOLD_OPEN_INVENTORY,
  HOLD_OPEN_HANDOVER,
  HOLD_REQUEST_RESERVATION(),
  HOLD_OPEN_WRITE_OFF('$3'),
);

export interface WriteOffRow {
  id: string;
  status: WriteOffStatus;
  cost_center_id: string;
  responsible_person_id: string;
  control_person_id: string | null;
  reason: WriteOffReason;
  reason_detail: string | null;
  technical_concept: string;
  final_disposition: string;
  observations: string | null;
  document_request_id: string | null;
  document_id: string | null;
  created_by: string;
}

interface AssetGuardRow {
  id: string;
  code: string;
  current_cost_center_id: string;
  reasons: string[];
}

const ROW_COLUMNS = `id, status, cost_center_id, responsible_person_id, control_person_id, reason, reason_detail,
  technical_concept, final_disposition, observations, document_request_id, document_id, created_by`;

const clean = (value: string | null | undefined): string | null => value?.trim() || null;

const bogotaDate = (date: Date): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(date);

@Injectable()
export class WriteOffsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly engine: DocumentEngineService,
    private readonly lifecycle: DocumentLifecycleRegistry,
    private readonly permissions: PermissionsService,
    private readonly controlSigners: ControlSignersService,
    @Inject('AuditLogsRepository')
    private readonly auditLogs: AuditLogsRepository,
  ) {}

  reasons(): WriteOffReasonOptionDto[] {
    return WRITE_OFF_REASONS.map((code) => ({ code, label: WRITE_OFF_REASON_LABELS[code], requiresDetail: code === 'OTHER' }));
  }

  async readScope(actor: AuthenticatedUser): Promise<ReadableCostCenterScope> {
    if (await this.permissions.userHasPermission(actor.id, WRITE_OFF_MANAGE)) {
      return { kind: 'GLOBAL' };
    }
    return requireReadableScope(await this.permissions.costCenterScope(actor.id, ASSET_READ_GLOBAL, ASSET_READ_SCOPED));
  }

  async list(query: QueryWriteOffsDto, actor: AuthenticatedUser): Promise<WriteOffListResponseDto> {
    const scope = costCenterFilter(await this.readScope(actor));
    const params = [query.status ?? null, query.costCenterId ?? null, scope];
    const where = `($1::text IS NULL OR w.status = $1)
      AND ($2::uuid IS NULL OR w.cost_center_id = $2)
      AND ($3::uuid[] IS NULL OR w.cost_center_id = ANY($3))`;
    const [count] = (await this.dataSource.query(`SELECT count(*)::int AS total FROM asset_write_off w WHERE ${where}`, params)) as Array<{
      total: number;
    }>;
    const items = (await this.dataSource.query(
      `SELECT w.id, w.status, ${CENTER_JSON('cc')} AS "costCenter", w.reason,
              (SELECT count(*)::int FROM asset_write_off_item i WHERE i.write_off_id = w.id) AS "assetCount",
              CASE WHEN w.document_id IS NOT NULL THEN 'GENERATED' WHEN r.id IS NULL THEN 'NONE' ELSE r.status END AS generation,
              w.document_id AS "documentId", d.number AS "documentNumber", w.created_at AS "createdAt", w.completed_at AS "completedAt"
       FROM asset_write_off w
       JOIN cost_center cc ON cc.id = w.cost_center_id
       LEFT JOIN document_request r ON r.id = w.document_request_id
       LEFT JOIN document d ON d.id = w.document_id
       WHERE ${where}
       ORDER BY w.created_at DESC, w.id DESC
       LIMIT $4 OFFSET $5`,
      [...params, query.pageSize, (query.page - 1) * query.pageSize],
    )) as WriteOffListItemDto[];
    const total = count?.total ?? 0;
    return { items, page: query.page, pageSize: query.pageSize, total, hasNext: query.page * query.pageSize < total };
  }

  async getById(id: string, actor: AuthenticatedUser): Promise<WriteOffDetailDto> {
    const scope = costCenterFilter(await this.readScope(actor));
    const [row] = UUID.test(id)
      ? ((await this.dataSource.query('SELECT cost_center_id FROM asset_write_off WHERE id = $1', [id])) as Array<{ cost_center_id: string }>)
      : [];
    if (!row || (scope && !scope.includes(row.cost_center_id))) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'No encontramos la baja.');
    }
    return this.detail(id);
  }

  async detail(id: string, manager: EntityManager = this.dataSource.manager): Promise<WriteOffDetailDto> {
    const [row] = (await manager.query(
      `SELECT w.id, w.status, w.cost_center_id, w.document_request_id, w.document_id,
              ${CENTER_JSON('cc')} AS "costCenter",
              ${PERSON_JSON('rp')} AS responsible, ${PERSON_JSON('cp')} AS "controlSigner",
              w.reason, w.reason_detail AS "reasonDetail", w.technical_concept AS "technicalConcept",
              w.final_disposition AS "finalDisposition", w.observations,
              ${USER_JSON('cu', 'cup')} AS "createdBy", w.created_at AS "createdAt",
              ${USER_JSON('gu', 'gup')} AS "generatedBy", w.generated_at AS "generatedAt",
              w.completed_at AS "completedAt", w.rejected_at AS "rejectedAt", w.cancelled_at AS "cancelledAt",
              ${USER_JSON('xu', 'xup')} AS "cancelledBy", w.cancel_reason AS "cancelReason"
       FROM asset_write_off w
       JOIN cost_center cc ON cc.id = w.cost_center_id
       JOIN person rp ON rp.id = w.responsible_person_id
       LEFT JOIN person cp ON cp.id = w.control_person_id
       JOIN app_user cu ON cu.id = w.created_by
       LEFT JOIN person cup ON cup.id = cu.person_id
       LEFT JOIN app_user gu ON gu.id = w.generated_by
       LEFT JOIN person gup ON gup.id = gu.person_id
       LEFT JOIN app_user xu ON xu.id = w.cancelled_by
       LEFT JOIN person xup ON xup.id = xu.person_id
       WHERE w.id = $1`,
      [id],
    )) as Array<
      Omit<WriteOffDetailDto, 'items' | 'document' | 'reasonLabel' | 'dependencia'> & {
        cost_center_id: string;
        document_request_id: string | null;
        document_id: string | null;
      }
    >;
    if (!row) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'No encontramos la baja.');
    }
    const items = (await manager.query(
      `SELECT i.id, i.line_number AS "lineNumber",
              json_build_object('id', a.id, 'code', ${ASSET_CODE}, 'description', a.description,
                'operationalStatus', a.operational_status) AS asset,
              i.movement_id AS "movementId"
       FROM asset_write_off_item i
       JOIN asset a ON a.id = i.asset_id
       WHERE i.write_off_id = $1 ORDER BY i.line_number`,
      [id],
    )) as WriteOffItemDto[];
    const { cost_center_id: costCenterId, document_request_id: requestId, document_id: documentId, ...writeOff } = row;
    const unit = await unitAt(manager, costCenterId, new Date());
    return {
      ...writeOff,
      reasonLabel: WRITE_OFF_REASON_LABELS[writeOff.reason],
      dependencia: unit?.name ?? null,
      items,
      document: await this.documentState(id, requestId, documentId, manager),
    };
  }

  private async documentState(
    writeOffId: string,
    requestId: string | null,
    documentId: string | null,
    manager: EntityManager,
  ): Promise<WriteOffDocumentDto> {
    const state = await this.lifecycle.stateFor(WRITE_OFF_ENTITY_TYPE, writeOffId, { formatKey: WRITE_OFF_FORMAT_KEY, manager });
    const request = requestId ? state.requests.find((item) => item.requestId === requestId) : undefined;
    const document = documentId ? state.documents.find((item) => item.documentId === documentId) : undefined;
    const signatures = documentId
      ? ((await manager.query(
          `SELECT sign_order AS "order", role, signer_person_id AS "personId", signer_name AS name, status, signed_at AS "signedAt"
           FROM document_signature WHERE document_id = $1 ORDER BY sign_order`,
          [documentId],
        )) as WriteOffDocumentDto['signatures'])
      : [];
    const failed = request?.status === 'FAILED';
    return {
      generation: documentId ? 'GENERATED' : (request?.status ?? (requestId ? 'PENDING' : 'NONE')),
      requestId,
      attempts: request?.attempts ?? 0,
      lastError: failed ? (request?.lastError ?? null) : null,
      retriesAutomatically: failed && (request?.attempts ?? 0) < AUTOMATIC_GENERATION_ATTEMPTS,
      retryable: failed && !request?.documentId,
      documentId,
      number: document?.number ?? null,
      status: (document?.status as WriteOffDocumentDto['status']) ?? null,
      signedAt: document?.signedAt ? new Date(document.signedAt).toISOString() : null,
      lifecycleError: document?.lifecycleError ?? null,
      signatures,
    };
  }

  async create(dto: CreateWriteOffDto, actor: AuthenticatedUser): Promise<WriteOffDetailDto> {
    const id = await this.dataSource.transaction(async (manager) => {
      assertReasonDetail(dto.reason, dto.reasonDetail ?? null);
      const costCenterId = await this.assertAssets(manager, dto.assetIds, null, null);
      const responsible = await this.resolveResponsible(manager, costCenterId, dto.responsiblePersonId);
      const [row] = (await manager.query(
        `INSERT INTO asset_write_off (cost_center_id, responsible_person_id, reason, reason_detail, technical_concept,
           final_disposition, observations, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [
          costCenterId,
          responsible,
          dto.reason,
          clean(dto.reasonDetail),
          dto.technicalConcept.trim(),
          dto.finalDisposition.trim(),
          clean(dto.observations),
          actor.id,
        ],
      )) as Array<{ id: string }>;
      const created = row?.id ?? '';
      await this.insertItems(manager, created, dto.assetIds);
      await this.audit(manager, AuditAction.WriteOffCreated, created, actor.id, {
        costCenterId,
        reason: dto.reason,
        assetIds: dto.assetIds,
      });
      return created;
    });
    return this.detail(id);
  }

  async update(id: string, dto: UpdateWriteOffDto, actor: AuthenticatedUser): Promise<WriteOffDetailDto> {
    await this.dataSource.transaction(async (manager) => {
      const writeOff = await this.lock(manager, id);
      if (!isWriteOffEditable(writeOff.status)) {
        throw new ApiException(ErrorCode.WriteOffInvalidStateTransition, 'La baja solo se edita mientras es borrador.');
      }
      const reason = dto.reason ?? writeOff.reason;
      const reasonDetail = dto.reasonDetail === undefined ? writeOff.reason_detail : clean(dto.reasonDetail);
      assertReasonDetail(reason, reasonDetail);
      if (dto.assetIds) {
        await manager.query('DELETE FROM asset_write_off_item WHERE write_off_id = $1', [id]);
        await this.assertAssets(manager, dto.assetIds, writeOff.cost_center_id, id);
        await this.insertItems(manager, id, dto.assetIds);
      }
      const responsible =
        dto.responsiblePersonId && dto.responsiblePersonId !== writeOff.responsible_person_id
          ? await this.resolveResponsible(manager, writeOff.cost_center_id, dto.responsiblePersonId)
          : writeOff.responsible_person_id;
      await manager.query(
        `UPDATE asset_write_off SET reason = $2, reason_detail = $3, technical_concept = $4, final_disposition = $5,
           observations = $6, responsible_person_id = $7
         WHERE id = $1`,
        [
          id,
          reason,
          reasonDetail,
          dto.technicalConcept?.trim() ?? writeOff.technical_concept,
          dto.finalDisposition?.trim() ?? writeOff.final_disposition,
          dto.observations === undefined ? writeOff.observations : clean(dto.observations),
          responsible,
        ],
      );
      await this.audit(manager, AuditAction.WriteOffUpdated, id, actor.id, {
        fields: Object.keys(dto),
        ...(dto.assetIds ? { assetIds: dto.assetIds } : {}),
      });
    });
    return this.detail(id);
  }

  async generate(id: string, dto: GenerateWriteOffActDto, actor: AuthenticatedUser): Promise<WriteOffDetailDto> {
    await this.dataSource.transaction(async (manager) => {
      const writeOff = await this.lock(manager, id);
      if (!canWriteOffTransition(writeOff.status, 'PENDING_SIGNATURES')) {
        throw new ApiException(ErrorCode.WriteOffInvalidStateTransition, 'El acta de la baja ya se generó o la baja está cerrada.');
      }
      const assetIds = await this.itemAssetIds(manager, id);
      if (assetIds.length === 0) {
        throw new ApiException(ErrorCode.ValidationFailed, 'La baja no tiene activos.');
      }
      await this.assertAssets(manager, assetIds, writeOff.cost_center_id, id);
      const control = await this.resolveControlSigner(manager, dto.controlSignerPersonId);
      const payload = await this.actPayload(manager, writeOff, assetIds, control, dto);
      const requestId = await this.engine.enqueue(manager, payload, actor.id);
      await manager.query(
        `UPDATE asset_write_off SET status = 'PENDING_SIGNATURES', document_request_id = $2, control_person_id = $3,
           generated_by = $4, generated_at = NOW()
         WHERE id = $1`,
        [id, requestId, control, actor.id],
      );
      await this.audit(manager, AuditAction.WriteOffActRequested, id, actor.id, {
        documentRequestId: requestId,
        signers: payload.signers,
        responsiblePersonId: payload.responsiblePersonId,
        ...(payload.signerSubstitutions ? { signerSubstitutions: payload.signerSubstitutions } : {}),
      });
    });
    return this.detail(id);
  }

  async cancel(id: string, reason: string, actor: AuthenticatedUser): Promise<WriteOffDetailDto> {
    const motive = reason.trim();
    if (motive.length < 5) {
      throw new ApiException(ErrorCode.ValidationFailed, 'Escriba el motivo de la cancelación.', [
        { field: 'reason', message: 'Escriba al menos 5 caracteres.' },
      ]);
    }
    await this.dataSource.transaction(async (manager) => {
      const current = await this.lock(manager, id);
      if (!canWriteOffTransition(current.status, 'CANCELLED')) {
        throw new ApiException(ErrorCode.WriteOffInvalidStateTransition, 'La baja no se puede cancelar en su estado actual.');
      }
      const [signed] = (await manager.query(
        `SELECT count(*)::int AS total FROM document_signature s JOIN document d ON d.id = s.document_id
         WHERE d.entity_type = $1 AND d.entity_id = $2 AND d.status = 'PENDING_SIGNATURE' AND s.status = 'SIGNED'`,
        [WRITE_OFF_ENTITY_TYPE, id],
      )) as Array<{ total: number }>;
      if ((signed?.total ?? 0) > 0) {
        throw new ApiException(
          ErrorCode.WriteOffInvalidStateTransition,
          'El acta de la baja ya tiene firmas y no se puede cancelar. Un firmante puede rechazarla.',
        );
      }
      const voided = await this.engine.voidForEntity(manager, {
        entityType: WRITE_OFF_ENTITY_TYPE,
        entityId: id,
        reason: motive,
        actorId: actor.id,
      });
      await manager.query(
        `UPDATE asset_write_off SET status = 'CANCELLED', cancelled_at = NOW(), cancelled_by = $2, cancel_reason = $3 WHERE id = $1`,
        [id, actor.id, motive],
      );
      await manager.query('UPDATE asset_write_off_item SET open = FALSE WHERE write_off_id = $1', [id]);
      await this.audit(manager, AuditAction.WriteOffCancelled, id, actor.id, {
        from: current.status,
        reason: motive,
        cancelledRequestIds: voided.cancelledRequestIds,
        voidedDocumentIds: voided.voidedDocumentIds,
      });
    });
    return this.detail(id);
  }

  async lock(manager: EntityManager, id: string): Promise<WriteOffRow> {
    const [row] = UUID.test(id)
      ? ((await manager.query(`SELECT ${ROW_COLUMNS} FROM asset_write_off WHERE id = $1 FOR UPDATE`, [id])) as WriteOffRow[])
      : [];
    if (!row) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'No encontramos la baja.');
    }
    return row;
  }

  async itemAssetIds(manager: EntityManager, id: string): Promise<string[]> {
    const rows = (await manager.query('SELECT asset_id FROM asset_write_off_item WHERE write_off_id = $1 ORDER BY line_number', [
      id,
    ])) as Array<{ asset_id: string }>;
    return rows.map((row) => row.asset_id);
  }

  private async insertItems(manager: EntityManager, writeOffId: string, assetIds: ReadonlyArray<string>): Promise<void> {
    try {
      await manager.query(
        `INSERT INTO asset_write_off_item (write_off_id, asset_id, line_number)
         SELECT $1, item.asset_id, item.line_number FROM unnest($2::uuid[]) WITH ORDINALITY AS item(asset_id, line_number)`,
        [writeOffId, assetIds],
      );
    } catch (error) {
      if (error instanceof QueryFailedError && (error.driverError as { constraint?: string })?.constraint === 'uq_asset_write_off_item_open') {
        throw new ApiException(ErrorCode.AssetInOpenWriteOff);
      }
      throw error;
    }
  }

  private async assertAssets(
    manager: EntityManager,
    assetIds: ReadonlyArray<string>,
    expectedCenter: string | null,
    ownWriteOff: string | null,
  ): Promise<string> {
    if (new Set(assetIds).size !== assetIds.length) {
      throw new ApiException(ErrorCode.ValidationFailed, 'Un activo aparece más de una vez en la baja.', [
        { field: 'assetIds', message: 'Hay activos repetidos.' },
      ]);
    }
    await manager.query('SELECT id FROM asset WHERE id = ANY($1) ORDER BY id FOR UPDATE', [assetIds]);
    const rows = (await manager.query(
      `SELECT a.id, ${ASSET_CODE} AS code, a.current_cost_center_id, ${BLOCKERS} AS reasons
       FROM asset a WHERE a.id = ANY($1)`,
      [assetIds, OPEN_LOAN_STATUSES, ownWriteOff],
    )) as AssetGuardRow[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const missing = assetIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new ApiException(
        ErrorCode.ResourceNotFound,
        'Algunos activos de la baja no existen.',
        missing.map(() => ({ field: 'assetIds', message: 'Este activo no existe.' })),
      );
    }
    const ordered = assetIds.map((id) => byId.get(id) as AssetGuardRow);
    const center = expectedCenter ?? ordered[0]?.current_cost_center_id ?? '';
    const elsewhere = ordered.filter((row) => row.current_cost_center_id !== center);
    if (elsewhere.length > 0) {
      throw new ApiException(
        ErrorCode.WriteOffMixedCostCenter,
        undefined,
        elsewhere.map((row) => ({ field: 'assetIds', message: `El activo ${row.code} está en otro centro de costo.` })),
      );
    }
    const held = ordered.filter((row) => row.reasons.length > 0);
    if (held.length > 0) {
      throw new ApiException(
        ErrorCode.WriteOffAssetHeld,
        undefined,
        held.map((row) => ({ field: 'assetIds', message: `El activo ${row.code} ${row.reasons.join(', ')}.` })),
      );
    }
    return center;
  }

  private async resolveResponsible(manager: EntityManager, costCenterId: string, requested: string | undefined): Promise<string> {
    if (requested) {
      const [person] = (await manager.query('SELECT id FROM person WHERE id = $1 AND is_active', [requested])) as unknown[];
      if (!person) {
        throw new ApiException(ErrorCode.ResourceNotFound, 'No encontramos a la persona responsable.', [
          { field: 'responsiblePersonId', message: 'Elija otra persona.' },
        ]);
      }
      return requested;
    }
    await assertCostCenterHasHead(manager, costCenterId, new Date(), 'responsiblePersonId');
    const [head] = (await manager.query(
      `SELECT h.person_id FROM cost_center_head h JOIN person p ON p.id = h.person_id AND p.is_active
       WHERE ${currentHeadCondition('$1::uuid', 'NOW()')}
       ORDER BY h.valid_from DESC, h.person_id LIMIT 1`,
      [costCenterId],
    )) as Array<{ person_id: string }>;
    if (!head) {
      throw new ApiException(ErrorCode.ValidationFailed, 'El jefe del centro de costo no está activo. Elija la persona responsable.', [
        { field: 'responsiblePersonId', message: 'Elija la persona responsable.' },
      ]);
    }
    return head.person_id;
  }

  private async resolveControlSigner(manager: EntityManager, requested: string | undefined): Promise<string> {
    if (requested) {
      return requested;
    }
    const candidates = await this.controlSigners.holders(CONTROL_SIGNER_PERMISSION, manager);
    const [only, ...others] = candidates;
    if (!only) {
      throw new ApiException(ErrorCode.WriteOffNoControlSigner);
    }
    if (others.length > 0) {
      throw new ApiException(ErrorCode.WriteOffSignerRequired, `${candidates.length} personas pueden firmar por Control Interno. Elija una.`, [
        { field: 'controlSignerPersonId', message: 'Elija quién firma por Control Interno.' },
      ]);
    }
    return only.personId;
  }

  private async actPayload(
    manager: EntityManager,
    writeOff: WriteOffRow,
    assetIds: ReadonlyArray<string>,
    control: string,
    dto: GenerateWriteOffActDto,
  ): Promise<DocumentRequestPayload> {
    const valuationDate = bogotaDate(new Date());
    const [year = 0, month = 0] = valuationDate.split('-').map(Number);
    const assets = (await manager.query(
      `SELECT a.id, a.serial_number AS "serialNumber", to_char(a.acquisition_date, 'YYYY-MM-DD') AS "acquisitionDate",
              a.acquisition_price::text AS price, d.book_value::text AS depreciated
       FROM unnest($1::uuid[]) WITH ORDINALITY AS x(id, position)
       JOIN asset a ON a.id = x.id
       LEFT JOIN LATERAL (
         SELECT dep.book_value FROM asset_depreciation dep
         WHERE dep.asset_id = a.id AND (dep.period_year * 100 + dep.period_month) <= $2
         ORDER BY dep.period_year DESC, dep.period_month DESC
         LIMIT 1
       ) d ON TRUE
       ORDER BY x.position`,
      [assetIds, year * 100 + month],
    )) as Array<{ id: string; serialNumber: string | null; acquisitionDate: string | null; price: string | null; depreciated: string | null }>;
    const toNumber = (value: string | null): number | null => (value === null ? null : Number(value));
    const content = buildWriteOffActContent({
      reason: writeOff.reason,
      reasonDetail: writeOff.reason_detail,
      technicalConcept: writeOff.technical_concept,
      finalDisposition: writeOff.final_disposition,
      observations: writeOff.observations,
      valuationDate,
      assets: assets.map((asset) => ({
        id: asset.id,
        serialNumber: asset.serialNumber,
        acquisitionDate: asset.acquisitionDate,
        acquisitionPrice: toNumber(asset.price),
        depreciatedValue: toNumber(asset.depreciated),
      })),
    });
    return {
      formatKey: WRITE_OFF_FORMAT_KEY,
      entityType: WRITE_OFF_ENTITY_TYPE,
      entityId: writeOff.id,
      costCenterId: writeOff.cost_center_id,
      responsiblePersonId: writeOff.responsible_person_id,
      signers: { AUDITA: control },
      ...(dto.signerSubstitutions && Object.keys(dto.signerSubstitutions).length > 0 ? { signerSubstitutions: dto.signerSubstitutions } : {}),
      assetIds: [...assetIds],
      assetFields: content.assetFields,
      fields: content.fields,
    };
  }

  async audit(manager: EntityManager, action: AuditAction, writeOffId: string, actorId: string, changes: Record<string, unknown>): Promise<void> {
    await this.auditLogs.record(
      { action, entityType: WRITE_OFF_ENTITY_TYPE, entityId: writeOffId, performedBy: actorId, ipAddress: null, userAgent: null, changes },
      manager,
    );
  }
}

const assertReasonDetail = (reason: WriteOffReason, detail: string | null): void => {
  if (reason === 'OTHER' && (detail?.trim().length ?? 0) < 3) {
    throw new ApiException(ErrorCode.ValidationFailed, 'Escriba el detalle del motivo.', [
      { field: 'reasonDetail', message: 'Escriba al menos 3 caracteres.' },
    ]);
  }
};
