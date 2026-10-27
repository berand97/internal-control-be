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
import { CONTROL_SIGNER_PERMISSION } from '../../documents/domain/signer-separation.js';
import { DocumentLifecycleRegistry } from '../../documents/lifecycle/document-lifecycle.registry.js';
import { ControlSignersService } from '../../documents/services/control-signers.service.js';
import { DocumentEngineService, type DocumentRequestPayload } from '../../documents/services/document-engine.service.js';
import { OPEN_LOAN_STATUSES } from '../../loans/enums/loan-status.js';
import { costCenterFilter, type ReadableCostCenterScope, requireReadableScope } from '../../roles/services/cost-center-scope.js';
import { PermissionsService } from '../../roles/services/permissions.service.js';
import { TRANSFER_SIGN_ACCOUNTING } from '../../transfers/domain/transfer.js';
import { buildWriteOffActContent, totalsOf, type WriteOffActItem } from '../domain/write-off-act.js';
import {
  ASSET_READ_GLOBAL,
  ASSET_READ_SCOPED,
  canWriteOffTransition,
  isWriteOffEditable,
  WRITE_OFF_ENTITY_TYPE,
  WRITE_OFF_FORMAT_KEY,
  WRITE_OFF_ITEM_STATE_LABELS,
  WRITE_OFF_ITEM_STATES,
  WRITE_OFF_MANAGE,
  type WriteOffStatus,
} from '../domain/write-off.js';
import type {
  CreateWriteOffDto,
  GenerateWriteOffActDto,
  QueryWriteOffsDto,
  UpdateWriteOffDto,
  WriteOffItemInputDto,
} from '../dto/write-off.dto.js';
import type {
  WriteOffDetailDto,
  WriteOffDocumentDto,
  WriteOffItemDto,
  WriteOffItemStateOptionDto,
  WriteOffListItemDto,
  WriteOffListResponseDto,
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

const ITEM_CENTERS = (alias: string) => `coalesce((SELECT json_agg(json_build_object('id', c.id, 'code', c.external_code, 'name', c.name)
    ORDER BY c.external_code) FROM cost_center c
    WHERE c.id IN (SELECT wi.cost_center_id FROM asset_write_off_item wi WHERE wi.write_off_id = ${alias}.id)), '[]'::json)`;

const REPORT_TOTAL = (alias: string) => `coalesce((SELECT sum(a.acquisition_price) FROM asset_write_off_item wi JOIN asset a ON a.id = wi.asset_id
    WHERE wi.write_off_id = ${alias}.id), 0)::float8`;

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
  control_person_id: string | null;
  accounting_person_id: string | null;
  authorized_total: string | null;
  council_agreement_number: string | null;
  council_agreement_date: string | null;
  vicefinance_reports: string | null;
  observations: string | null;
  document_request_id: string | null;
  document_id: string | null;
  created_by: string;
}

interface AssetGuardRow {
  id: string;
  code: string;
  reasons: string[];
}

const ROW_COLUMNS = `id, status, control_person_id, accounting_person_id, authorized_total::text AS authorized_total,
  council_agreement_number, to_char(council_agreement_date, 'YYYY-MM-DD') AS council_agreement_date, vicefinance_reports,
  observations, document_request_id, document_id, created_by`;

type SignerKind = 'CONTROL' | 'ACCOUNTING';

const SIGNER: Readonly<Record<SignerKind, { permission: string; field: string; label: string; none: ErrorCode }>> = {
  CONTROL: {
    permission: CONTROL_SIGNER_PERMISSION,
    field: 'controlSignerPersonId',
    label: 'Control Interno',
    none: ErrorCode.WriteOffNoControlSigner,
  },
  ACCOUNTING: {
    permission: TRANSFER_SIGN_ACCOUNTING,
    field: 'accountingSignerPersonId',
    label: 'Contabilidad',
    none: ErrorCode.WriteOffNoAccountingSigner,
  },
};

const clean = (value: string | null | undefined): string | null => value?.trim() || null;

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

  itemStates(): WriteOffItemStateOptionDto[] {
    return WRITE_OFF_ITEM_STATES.map((code) => ({ code, label: WRITE_OFF_ITEM_STATE_LABELS[code] }));
  }

  accountingSigners(): Promise<Array<{ personId: string; name: string }>> {
    return this.controlSigners.holders(TRANSFER_SIGN_ACCOUNTING);
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
      AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM asset_write_off_item fi WHERE fi.write_off_id = w.id AND fi.cost_center_id = $2))
      AND ($3::uuid[] IS NULL OR EXISTS (SELECT 1 FROM asset_write_off_item si WHERE si.write_off_id = w.id AND si.cost_center_id = ANY($3)))`;
    const [count] = (await this.dataSource.query(`SELECT count(*)::int AS total FROM asset_write_off w WHERE ${where}`, params)) as Array<{
      total: number;
    }>;
    const items = (await this.dataSource.query(
      `SELECT w.id, w.status, ${ITEM_CENTERS('w')} AS "costCenters",
              (SELECT count(*)::int FROM asset_write_off_item i WHERE i.write_off_id = w.id) AS "assetCount",
              ${REPORT_TOTAL('w')} AS "reportTotal", w.authorized_total::float8 AS "authorizedTotal",
              CASE WHEN w.document_id IS NOT NULL THEN 'GENERATED' WHEN r.id IS NULL THEN 'NONE' ELSE r.status END AS generation,
              w.document_id AS "documentId", d.number AS "documentNumber", w.created_at AS "createdAt", w.completed_at AS "completedAt"
       FROM asset_write_off w
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
      ? ((await this.dataSource.query(
          `SELECT w.id FROM asset_write_off w
           WHERE w.id = $1
             AND ($2::uuid[] IS NULL OR EXISTS (SELECT 1 FROM asset_write_off_item i WHERE i.write_off_id = w.id AND i.cost_center_id = ANY($2)))`,
          [id, scope],
        )) as Array<{ id: string }>)
      : [];
    if (!row) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'No encontramos la baja.');
    }
    return this.detail(id);
  }

  async detail(id: string, manager: EntityManager = this.dataSource.manager): Promise<WriteOffDetailDto> {
    const [row] = (await manager.query(
      `SELECT w.id, w.status, w.document_request_id, w.document_id, ${ITEM_CENTERS('w')} AS "costCenters",
              ${PERSON_JSON('cp')} AS "controlSigner", ${PERSON_JSON('ap')} AS "accountingSigner",
              w.authorized_total::float8 AS "authorizedTotal", w.council_agreement_number AS "councilAgreementNumber",
              to_char(w.council_agreement_date, 'YYYY-MM-DD') AS "councilAgreementDate", w.vicefinance_reports AS "vicefinanceReports",
              w.observations,
              ${USER_JSON('cu', 'cup')} AS "createdBy", w.created_at AS "createdAt",
              ${USER_JSON('gu', 'gup')} AS "generatedBy", w.generated_at AS "generatedAt",
              w.completed_at AS "completedAt", w.rejected_at AS "rejectedAt", w.cancelled_at AS "cancelledAt",
              ${USER_JSON('xu', 'xup')} AS "cancelledBy", w.cancel_reason AS "cancelReason"
       FROM asset_write_off w
       LEFT JOIN person cp ON cp.id = w.control_person_id
       LEFT JOIN person ap ON ap.id = w.accounting_person_id
       JOIN app_user cu ON cu.id = w.created_by
       LEFT JOIN person cup ON cup.id = cu.person_id
       LEFT JOIN app_user gu ON gu.id = w.generated_by
       LEFT JOIN person gup ON gup.id = gu.person_id
       LEFT JOIN app_user xu ON xu.id = w.cancelled_by
       LEFT JOIN person xup ON xup.id = xu.person_id
       WHERE w.id = $1`,
      [id],
    )) as Array<
      Omit<WriteOffDetailDto, 'items' | 'document' | 'reportTotal' | 'difference'> & {
        document_request_id: string | null;
        document_id: string | null;
      }
    >;
    if (!row) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'No encontramos la baja.');
    }
    const items = (await manager.query(
      `SELECT i.id, i.line_number AS "lineNumber",
              json_build_object('id', a.id, 'legacyId', coalesce(o.legacy_asset_id, a.internal_code), 'code', ${ASSET_CODE},
                'description', a.description, 'acquisitionDocument', a.acquisition_document,
                'acquisitionDate', to_char(a.acquisition_date, 'YYYY-MM-DD'), 'acquisitionPrice', a.acquisition_price::float8,
                'operationalStatus', a.operational_status) AS asset,
              ${CENTER_JSON('cc')} AS "costCenter", i.quantity, i.state, i.notes, i.movement_id AS "movementId"
       FROM asset_write_off_item i
       JOIN asset a ON a.id = i.asset_id
       LEFT JOIN asset_import_origin o ON o.asset_id = a.id
       JOIN cost_center cc ON cc.id = i.cost_center_id
       WHERE i.write_off_id = $1 ORDER BY i.line_number`,
      [id],
    )) as Array<Omit<WriteOffItemDto, 'stateLabel'>>;
    const { document_request_id: requestId, document_id: documentId, ...writeOff } = row;
    const totals = totalsOf(
      items.map((item) => item.asset.acquisitionPrice),
      writeOff.authorizedTotal,
    );
    return {
      ...writeOff,
      reportTotal: totals.report,
      difference: totals.difference,
      items: items.map((item) => ({ ...item, stateLabel: WRITE_OFF_ITEM_STATE_LABELS[item.state] })),
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
      await this.assertAssets(manager, dto.items, null);
      const [row] = (await manager.query(
        `INSERT INTO asset_write_off (authorized_total, council_agreement_number, council_agreement_date, vicefinance_reports,
           observations, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          dto.authorizedTotal ?? null,
          clean(dto.councilAgreementNumber),
          dto.councilAgreementDate ?? null,
          clean(dto.vicefinanceReports),
          clean(dto.observations),
          actor.id,
        ],
      )) as Array<{ id: string }>;
      const created = row?.id ?? '';
      await this.insertItems(manager, created, dto.items);
      await this.audit(manager, AuditAction.WriteOffCreated, created, actor.id, {
        assetIds: dto.items.map((item) => item.assetId),
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
      if (dto.items) {
        await manager.query('DELETE FROM asset_write_off_item WHERE write_off_id = $1', [id]);
        await this.assertAssets(manager, dto.items, id);
        await this.insertItems(manager, id, dto.items);
      }
      await manager.query(
        `UPDATE asset_write_off SET authorized_total = $2, council_agreement_number = $3, council_agreement_date = $4,
           vicefinance_reports = $5, observations = $6
         WHERE id = $1`,
        [
          id,
          dto.authorizedTotal === undefined ? writeOff.authorized_total : dto.authorizedTotal,
          dto.councilAgreementNumber === undefined ? writeOff.council_agreement_number : clean(dto.councilAgreementNumber),
          dto.councilAgreementDate === undefined ? writeOff.council_agreement_date : dto.councilAgreementDate,
          dto.vicefinanceReports === undefined ? writeOff.vicefinance_reports : clean(dto.vicefinanceReports),
          dto.observations === undefined ? writeOff.observations : clean(dto.observations),
        ],
      );
      await this.audit(manager, AuditAction.WriteOffUpdated, id, actor.id, {
        fields: Object.keys(dto),
        ...(dto.items ? { assetIds: dto.items.map((item) => item.assetId) } : {}),
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
      if (writeOff.authorized_total === null) {
        throw new ApiException(ErrorCode.ValidationFailed, 'Escriba el total autorizado de la baja.', [
          { field: 'authorizedTotal', message: 'Escriba el total autorizado.' },
        ]);
      }
      const items = await this.itemInputs(manager, id);
      if (items.length === 0) {
        throw new ApiException(ErrorCode.ValidationFailed, 'La baja no tiene activos.');
      }
      await this.assertAssets(manager, items, id);
      const control = await this.resolveSigner(manager, 'CONTROL', dto.controlSignerPersonId);
      const accounting = await this.resolveSigner(manager, 'ACCOUNTING', dto.accountingSignerPersonId);
      const payload = await this.actPayload(manager, writeOff, control, accounting, dto);
      const requestId = await this.engine.enqueue(manager, payload, actor.id);
      await manager.query(
        `UPDATE asset_write_off SET status = 'PENDING_SIGNATURES', document_request_id = $2, control_person_id = $3,
           accounting_person_id = $4, generated_by = $5, generated_at = NOW()
         WHERE id = $1`,
        [id, requestId, control, accounting, actor.id],
      );
      await this.audit(manager, AuditAction.WriteOffActRequested, id, actor.id, {
        documentRequestId: requestId,
        signers: payload.signers,
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

  async itemInputs(manager: EntityManager, id: string): Promise<WriteOffItemInputDto[]> {
    return (await manager.query(
      'SELECT asset_id AS "assetId", quantity, state, notes FROM asset_write_off_item WHERE write_off_id = $1 ORDER BY line_number',
      [id],
    )) as WriteOffItemInputDto[];
  }

  private async insertItems(manager: EntityManager, writeOffId: string, items: ReadonlyArray<WriteOffItemInputDto>): Promise<void> {
    try {
      await manager.query(
        `INSERT INTO asset_write_off_item (write_off_id, asset_id, line_number, cost_center_id, quantity, state, notes)
         SELECT $1, item.asset_id, item.line_number, a.current_cost_center_id, item.quantity, item.state, item.notes
         FROM unnest($2::uuid[], $3::int[], $4::text[], $5::text[]) WITH ORDINALITY AS item(asset_id, quantity, state, notes, line_number)
         JOIN asset a ON a.id = item.asset_id`,
        [
          writeOffId,
          items.map((item) => item.assetId),
          items.map((item) => item.quantity ?? 1),
          items.map((item) => item.state),
          items.map((item) => clean(item.notes)),
        ],
      );
    } catch (error) {
      if (error instanceof QueryFailedError && (error.driverError as { constraint?: string })?.constraint === 'uq_asset_write_off_item_open') {
        throw new ApiException(ErrorCode.AssetInOpenWriteOff);
      }
      throw error;
    }
  }

  private async assertAssets(manager: EntityManager, items: ReadonlyArray<WriteOffItemInputDto>, ownWriteOff: string | null): Promise<void> {
    const assetIds = items.map((item) => item.assetId);
    if (new Set(assetIds).size !== assetIds.length) {
      throw new ApiException(ErrorCode.ValidationFailed, 'Un activo aparece más de una vez en la baja.', [
        { field: 'items', message: 'Hay activos repetidos.' },
      ]);
    }
    await manager.query('SELECT id FROM asset WHERE id = ANY($1) ORDER BY id FOR UPDATE', [assetIds]);
    const rows = (await manager.query(
      `SELECT a.id, ${ASSET_CODE} AS code, ${BLOCKERS} AS reasons FROM asset a WHERE a.id = ANY($1)`,
      [assetIds, OPEN_LOAN_STATUSES, ownWriteOff],
    )) as AssetGuardRow[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const missing = assetIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new ApiException(
        ErrorCode.ResourceNotFound,
        'Algunos activos de la baja no existen.',
        missing.map(() => ({ field: 'items', message: 'Este activo no existe.' })),
      );
    }
    const held = assetIds.map((id) => byId.get(id) as AssetGuardRow).filter((row) => row.reasons.length > 0);
    if (held.length > 0) {
      throw new ApiException(
        ErrorCode.WriteOffAssetHeld,
        undefined,
        held.map((row) => ({ field: 'items', message: `El activo ${row.code} ${row.reasons.join(', ')}.` })),
      );
    }
  }

  private async resolveSigner(manager: EntityManager, kind: SignerKind, requested: string | undefined): Promise<string> {
    const spec = SIGNER[kind];
    const candidates = await this.controlSigners.holders(spec.permission, manager);
    if (candidates.length === 0) {
      throw new ApiException(spec.none);
    }
    if (requested) {
      if (!candidates.some((candidate) => candidate.personId === requested)) {
        throw new ApiException(ErrorCode.WriteOffSignerNotEligible, `Esta persona no puede firmar por ${spec.label}.`, [
          { field: spec.field, message: `No puede firmar por ${spec.label}.` },
        ]);
      }
      return requested;
    }
    const [only, ...others] = candidates;
    if (!only || others.length > 0) {
      throw new ApiException(ErrorCode.WriteOffSignerRequired, `${candidates.length} personas pueden firmar por ${spec.label}. Elija una.`, [
        { field: spec.field, message: `Elija quién firma por ${spec.label}.` },
      ]);
    }
    return only.personId;
  }

  private async actPayload(
    manager: EntityManager,
    writeOff: WriteOffRow,
    control: string,
    accounting: string,
    dto: GenerateWriteOffActDto,
  ): Promise<DocumentRequestPayload> {
    const rows = (await manager.query(
      `SELECT i.asset_id AS "assetId", i.quantity, i.state, i.notes, cc.external_code || ' ' || cc.name AS "costCenter",
              a.acquisition_document AS "acquisitionDocument", to_char(a.acquisition_date, 'YYYY-MM-DD') AS "acquisitionDate",
              a.acquisition_price::text AS price
       FROM asset_write_off_item i
       JOIN asset a ON a.id = i.asset_id
       JOIN cost_center cc ON cc.id = i.cost_center_id
       WHERE i.write_off_id = $1 ORDER BY i.line_number`,
      [writeOff.id],
    )) as Array<Omit<WriteOffActItem, 'acquisitionPrice'> & { price: string | null }>;
    const content = buildWriteOffActContent({
      authorizedTotal: Number(writeOff.authorized_total),
      observations: writeOff.observations,
      councilAgreementNumber: writeOff.council_agreement_number,
      councilAgreementDate: writeOff.council_agreement_date,
      vicefinanceReports: writeOff.vicefinance_reports,
      items: rows.map(({ price, ...item }) => ({ ...item, acquisitionPrice: price === null ? null : Number(price) })),
    });
    return {
      formatKey: WRITE_OFF_FORMAT_KEY,
      entityType: WRITE_OFF_ENTITY_TYPE,
      entityId: writeOff.id,
      signers: { CONTROL_INTERNO: control, CONTABILIDAD: accounting },
      ...(dto.signerSubstitutions && Object.keys(dto.signerSubstitutions).length > 0 ? { signerSubstitutions: dto.signerSubstitutions } : {}),
      assetIds: rows.map((row) => row.assetId),
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
