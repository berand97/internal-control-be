import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type EntityManager, QueryFailedError } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import type { ErrorDetail } from '../../../common/types/response-envelope.type.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import type { AuditLogsRepository } from '../../auth/repositories/audit-logs.repository.interface.js';
import { unitAt } from '../../cost-centers/domain/placement-at.js';
import { DocumentLifecycleRegistry } from '../../documents/lifecycle/document-lifecycle.registry.js';
import {
  CONDITION_LABELS,
  DocumentEngineService,
  type DocumentRequestPayload,
} from '../../documents/services/document-engine.service.js';
import { OPEN_LOAN_STATUSES } from '../../loans/enums/loan-status.js';
import { costCenterFilter, type ReadableCostCenterScope, requireReadableScope } from '../../roles/services/cost-center-scope.js';
import { PermissionsService } from '../../roles/services/permissions.service.js';
import {
  ASSET_READ_GLOBAL,
  ASSET_READ_SCOPED,
  canTransferTransition,
  TRANSFER_ENTITY_TYPE,
  TRANSFER_FORMAT_KEY,
  TRANSFER_READ_GLOBAL,
  type TransferStatus,
} from '../domain/transfer.js';
import type {
  CreateTransferDto,
  GenerateTransferActDto,
  QueryTransfersDto,
  TransferItemInputDto,
} from '../dto/transfer.dto.js';
import type {
  TransferDetailDto,
  TransferDocumentDto,
  TransferItemDto,
  TransferListItemDto,
  TransferListResponseDto,
} from '../dto/transfer.responses.js';
import { TransferSignersService } from './transfer-signers.service.js';

/** Reintentos automáticos del outbox (DocumentEngineService.processPending: attempts < 5). */
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

export interface TransferRow {
  id: string;
  status: TransferStatus;
  source_cost_center_id: string;
  target_cost_center_id: string;
  requester_person_id: string;
  owner_person_id: string;
  control_person_id: string | null;
  document_request_id: string | null;
  document_id: string | null;
  created_by: string;
  justification: string;
}

interface AssetGuardRow {
  id: string;
  code: string;
  current_cost_center_id: string;
  operational_status: string;
  physical_condition: string;
  open_inventories: number;
  active_loans: number;
  open_transfer: string | null;
}

export interface CreateTransferInput {
  readonly items: ReadonlyArray<TransferItemInputDto>;
  readonly targetCostCenterId: string;
  readonly requesterPersonId: string;
  readonly ownerPersonId: string;
  readonly justification: string;
}

const yesNo = (value: boolean): string => (value ? 'Sí' : 'No');

const money = (value: string | null): string =>
  value === null
    ? ''
    : new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 2 }).format(Number(value));

/**
 * Traslado de activos entre centros de costo con su acta OCI-17-89 (estados en domain/transfer.ts).
 *
 * Guardas (al crear, al editar, al generar y otra vez al aplicar el acta firmada): activos existentes, del mismo centro
 * de origen, no dados de baja ni ON_LOAN, sin toma física abierta (PLANNED/IN_PROGRESS), sin préstamo abierto que los
 * retenga (misma definición que LoansService.create) y fuera de otro traslado abierto. Son las guardas que tenía
 * AssetsService.reassignCostCenter, que ya no está en el API: el centro de costo de un activo solo cambia por un
 * traslado con acta firmada.
 */
@Injectable()
export class TransfersService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly engine: DocumentEngineService,
    private readonly lifecycle: DocumentLifecycleRegistry,
    private readonly permissions: PermissionsService,
    private readonly signers: TransferSignersService,
    @Inject('AuditLogsRepository')
    private readonly auditLogs: AuditLogsRepository,
  ) {}

  // ---------- Lectura ----------

  /**
   * transfer:read:global (rol Contabilidad) o asset:read:global ven todos; asset:read:org_unit ve los traslados cuyo
   * centro de ORIGEN o DESTINO está en su alcance (asignaciones COST_CENTER ∪ jefaturas), como los préstamos.
   */
  async readScope(actor: AuthenticatedUser): Promise<ReadableCostCenterScope> {
    if (await this.permissions.userHasPermission(actor.id, TRANSFER_READ_GLOBAL)) {
      return { kind: 'GLOBAL' };
    }
    return requireReadableScope(
      await this.permissions.costCenterScope(actor.id, ASSET_READ_GLOBAL, ASSET_READ_SCOPED),
      `${TRANSFER_READ_GLOBAL}, ${ASSET_READ_GLOBAL}`,
      ASSET_READ_SCOPED,
    );
  }

  async list(query: QueryTransfersDto, actor: AuthenticatedUser): Promise<TransferListResponseDto> {
    const scope = costCenterFilter(await this.readScope(actor));
    const params = [
      query.status ?? null,
      query.sourceCostCenterId ?? null,
      query.targetCostCenterId ?? null,
      scope,
    ];
    const where = `($1::text IS NULL OR t.status = $1)
      AND ($2::uuid IS NULL OR t.source_cost_center_id = $2)
      AND ($3::uuid IS NULL OR t.target_cost_center_id = $3)
      AND ($4::uuid[] IS NULL OR t.source_cost_center_id = ANY($4) OR t.target_cost_center_id = ANY($4))`;
    const [count] = (await this.dataSource.query(`SELECT count(*)::int AS total FROM asset_transfer t WHERE ${where}`, params)) as Array<{
      total: number;
    }>;
    const rows = (await this.dataSource.query(
      `SELECT t.id, t.status, ${CENTER_JSON('sc')} AS "sourceCostCenter", ${CENTER_JSON('tc')} AS "targetCostCenter",
              ${PERSON_JSON('op')} AS owner,
              (SELECT count(*)::int FROM asset_transfer_item i WHERE i.transfer_id = t.id) AS "assetCount",
              CASE WHEN t.document_id IS NOT NULL THEN 'GENERATED' WHEN r.id IS NULL THEN 'NONE' ELSE r.status END AS generation,
              t.document_id AS "documentId", d.number AS "documentNumber", t.created_at AS "createdAt",
              t.completed_at AS "completedAt"
       FROM asset_transfer t
       JOIN cost_center sc ON sc.id = t.source_cost_center_id
       JOIN cost_center tc ON tc.id = t.target_cost_center_id
       JOIN person op ON op.id = t.owner_person_id
       LEFT JOIN document_request r ON r.id = t.document_request_id
       LEFT JOIN document d ON d.id = t.document_id
       WHERE ${where}
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT $5 OFFSET $6`,
      [...params, query.pageSize, (query.page - 1) * query.pageSize],
    )) as TransferListItemDto[];
    const total = count?.total ?? 0;
    return { items: rows, page: query.page, pageSize: query.pageSize, total, hasNext: query.page * query.pageSize < total };
  }

  /** Detalle con alcance de lectura: fuera de alcance responde 404, igual que inexistente. */
  async getById(id: string, actor: AuthenticatedUser): Promise<TransferDetailDto> {
    const scope = costCenterFilter(await this.readScope(actor));
    const [row] = (await this.dataSource.query(
      'SELECT source_cost_center_id, target_cost_center_id FROM asset_transfer WHERE id = $1',
      [id],
    )) as Array<{ source_cost_center_id: string; target_cost_center_id: string }>;
    if (!row || (scope && !scope.includes(row.source_cost_center_id) && !scope.includes(row.target_cost_center_id))) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'No existe el traslado');
    }
    return this.detail(id);
  }

  /** Detalle sin comprobar alcance: respuesta de las acciones, que ya exigieron su propio permiso. */
  async detail(id: string, manager: EntityManager = this.dataSource.manager): Promise<TransferDetailDto> {
    const [row] = (await manager.query(
      `SELECT t.id, t.status, t.document_request_id, t.document_id,
              ${CENTER_JSON('sc')} AS "sourceCostCenter", ${CENTER_JSON('tc')} AS "targetCostCenter",
              ${PERSON_JSON('rp')} AS requester, ${PERSON_JSON('op')} AS owner,
              ${PERSON_JSON('cp')} AS "controlSigner", ${PERSON_JSON('ap')} AS "accountingSigner",
              t.justification, t.asset_request_id AS "assetRequestId",
              ${USER_JSON('cu', 'cup')} AS "createdBy", t.created_at AS "createdAt",
              ${USER_JSON('gu', 'gup')} AS "generatedBy", t.generated_at AS "generatedAt",
              t.completed_at AS "completedAt", t.rejected_at AS "rejectedAt", t.cancelled_at AS "cancelledAt",
              ${USER_JSON('xu', 'xup')} AS "cancelledBy", t.cancel_reason AS "cancelReason"
       FROM asset_transfer t
       JOIN cost_center sc ON sc.id = t.source_cost_center_id
       JOIN cost_center tc ON tc.id = t.target_cost_center_id
       JOIN person rp ON rp.id = t.requester_person_id
       JOIN person op ON op.id = t.owner_person_id
       LEFT JOIN person cp ON cp.id = t.control_person_id
       LEFT JOIN person ap ON ap.id = t.accounting_person_id
       JOIN app_user cu ON cu.id = t.created_by
       LEFT JOIN person cup ON cup.id = cu.person_id
       LEFT JOIN app_user gu ON gu.id = t.generated_by
       LEFT JOIN person gup ON gup.id = gu.person_id
       LEFT JOIN app_user xu ON xu.id = t.cancelled_by
       LEFT JOIN person xup ON xup.id = xu.person_id
       WHERE t.id = $1`,
      [id],
    )) as Array<
      Omit<TransferDetailDto, 'items' | 'document' | 'controlSignerAvailable' | 'accountingSignerAvailable' | 'warnings'> & {
        document_request_id: string | null;
        document_id: string | null;
      }
    >;
    if (!row) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'No existe el traslado');
    }
    const items = (await manager.query(
      `SELECT i.id, i.line_number AS "lineNumber",
              json_build_object('id', a.id, 'code', ${ASSET_CODE}, 'description', a.description,
                'costCenterId', a.current_cost_center_id, 'operationalStatus', a.operational_status) AS asset,
              i.physical_condition AS "physicalCondition", i.physically_verified AS "physicallyVerified",
              i.verification_note AS "verificationNote", i.numbering_present AS "numberingPresent",
              json_build_object('id', r.id, 'code', r.code, 'name', r.name) AS reason,
              i.observations, i.movement_id AS "movementId"
       FROM asset_transfer_item i
       JOIN asset a ON a.id = i.asset_id
       JOIN asset_transfer_reason r ON r.id = i.reason_id
       WHERE i.transfer_id = $1 ORDER BY i.line_number`,
      [id],
    )) as TransferItemDto[];
    const { document_request_id: requestId, document_id: documentId, ...transfer } = row;
    return {
      ...transfer,
      items,
      document: await this.documentState(id, requestId, documentId, manager),
      ...(await this.signers.availability(manager)),
    };
  }

  private async documentState(
    transferId: string,
    requestId: string | null,
    documentId: string | null,
    manager: EntityManager,
  ): Promise<TransferDocumentDto> {
    const state = await this.lifecycle.stateFor(TRANSFER_ENTITY_TYPE, transferId, { formatKey: TRANSFER_FORMAT_KEY, manager });
    const request = requestId ? state.requests.find((item) => item.requestId === requestId) : undefined;
    const document = documentId ? state.documents.find((item) => item.documentId === documentId) : undefined;
    const signatures = documentId
      ? ((await manager.query(
          `SELECT sign_order AS "order", role, signer_person_id AS "personId", signer_name AS name, status, signed_at AS "signedAt"
           FROM document_signature WHERE document_id = $1 ORDER BY sign_order`,
          [documentId],
        )) as TransferDocumentDto['signatures'])
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
      status: (document?.status as TransferDocumentDto['status']) ?? null,
      signedAt: document?.signedAt ? new Date(document.signedAt).toISOString() : null,
      lifecycleError: document?.lifecycleError ?? null,
      signatures,
    };
  }

  // ---------- Crear y editar (DRAFT) ----------

  async create(dto: CreateTransferDto, actor: AuthenticatedUser): Promise<TransferDetailDto> {
    const id = await this.dataSource.transaction((manager) => this.createWithin(manager, dto, actor.id));
    return this.detail(id);
  }

  /**
   * Crea el traslado DRAFT dentro de la transacción del llamador. assetRequestId: la solicitud de activos que lo
   * origina (BE-2); quien la aprobó ya tiene el permiso de generación del formato.
   */
  async createWithin(
    manager: EntityManager,
    input: CreateTransferInput,
    actorId: string,
    options: { readonly assetRequestId?: string } = {},
  ): Promise<string> {
    const justification = input.justification.trim();
    if (justification.length < 3) {
      throw new ApiException(ErrorCode.ValidationFailed, 'La justificación es obligatoria', [
        { field: 'justification', message: 'Mínimo 3 caracteres' },
      ]);
    }
    await this.assertPersons(manager, [
      ['requesterPersonId', input.requesterPersonId, 'No existe la persona que entrega'],
      ['ownerPersonId', input.ownerPersonId, 'No existe la persona que recibe'],
    ]);
    const source = await this.assertItems(manager, input.items, null);
    await this.assertTarget(manager, source, input.targetCostCenterId);
    const [row] = (await manager.query(
      `INSERT INTO asset_transfer (source_cost_center_id, target_cost_center_id, requester_person_id, owner_person_id,
         justification, asset_request_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [source, input.targetCostCenterId, input.requesterPersonId, input.ownerPersonId, justification, options.assetRequestId ?? null, actorId],
    )) as Array<{ id: string }>;
    const id = row?.id ?? '';
    await this.insertItems(manager, id, input.items);
    await this.audit(manager, AuditAction.TransferCreated, id, actorId, {
      sourceCostCenterId: source,
      targetCostCenterId: input.targetCostCenterId,
      assetIds: input.items.map((item) => item.assetId),
      ...(options.assetRequestId ? { assetRequestId: options.assetRequestId } : {}),
    });
    return id;
  }

  /** Reemplaza los activos de un traslado DRAFT (mismo origen que el traslado). */
  async updateItems(id: string, items: ReadonlyArray<TransferItemInputDto>, actor: AuthenticatedUser): Promise<TransferDetailDto> {
    await this.dataSource.transaction(async (manager) => {
      const transfer = await this.lock(manager, id);
      if (transfer.status !== 'DRAFT') {
        throw new ApiException(ErrorCode.TransferInvalidStateTransition, `El traslado está ${transfer.status}: sus activos solo se editan en DRAFT`);
      }
      const before = (await manager.query('SELECT asset_id FROM asset_transfer_item WHERE transfer_id = $1 ORDER BY line_number', [
        id,
      ])) as Array<{ asset_id: string }>;
      await manager.query('DELETE FROM asset_transfer_item WHERE transfer_id = $1', [id]);
      await this.assertItems(manager, items, transfer.source_cost_center_id);
      await this.insertItems(manager, id, items);
      await this.audit(manager, AuditAction.TransferItemsUpdated, id, actor.id, {
        before: before.map((item) => item.asset_id),
        after: items.map((item) => item.assetId),
      });
    });
    return this.detail(id);
  }

  private async insertItems(manager: EntityManager, transferId: string, items: ReadonlyArray<TransferItemInputDto>): Promise<void> {
    try {
      await manager.query(
        `INSERT INTO asset_transfer_item (transfer_id, asset_id, line_number, physical_condition, physically_verified,
           verification_note, numbering_present, reason_id, observations)
         SELECT $1, item.asset_id, item.line_number, coalesce(item.physical_condition::asset_physical_condition, a.physical_condition),
                item.physically_verified, item.verification_note, item.numbering_present, item.reason_id, item.observations
         FROM unnest($2::uuid[], $3::text[], $4::boolean[], $5::text[], $6::boolean[], $7::uuid[], $8::text[])
           WITH ORDINALITY AS item(asset_id, physical_condition, physically_verified, verification_note, numbering_present,
             reason_id, observations, line_number)
         JOIN asset a ON a.id = item.asset_id`,
        [
          transferId,
          items.map((item) => item.assetId),
          items.map((item) => item.physicalCondition ?? null),
          items.map((item) => item.physicallyVerified ?? false),
          items.map((item) => item.verificationNote?.trim() || null),
          items.map((item) => item.numberingPresent ?? false),
          items.map((item) => item.reasonId),
          items.map((item) => item.observations?.trim() || null),
        ],
      );
    } catch (error) {
      // Dos traslados concurrentes con el mismo activo: el segundo choca con el índice de traslados abiertos.
      if (error instanceof QueryFailedError && (error.driverError as { constraint?: string })?.constraint === 'uq_asset_transfer_item_open') {
        throw new ApiException(ErrorCode.TransferAssetInOpenTransfer);
      }
      throw error;
    }
  }

  // ---------- Generar el acta ----------

  /**
   * Encola el acta OCI-17-89 en la misma transacción que pasa el traslado a PENDING_SIGNATURES. Firmantes: ENTREGA =
   * quien entrega, RECIBE = quien recibe, CONTROL_INTERNO y CONTABILIDAD según TransferSignersService; la separación de
   * funciones (nadie en dos firmas, salvo sustituto de Control Interno) la exige el motor.
   */
  async generate(id: string, dto: GenerateTransferActDto, actor: AuthenticatedUser): Promise<TransferDetailDto> {
    await this.dataSource.transaction((manager) => this.generateWithin(manager, id, dto, actor.id));
    return this.detail(id);
  }

  /** Genera el acta dentro de la transacción del llamador (generate o la solicitud de activos). */
  async generateWithin(manager: EntityManager, id: string, dto: GenerateTransferActDto, actorId: string): Promise<void> {
    const actor = { id: actorId };
    {
      const transfer = await this.lock(manager, id);
      if (!canTransferTransition(transfer.status, 'PENDING_SIGNATURES')) {
        throw new ApiException(ErrorCode.TransferInvalidStateTransition, `El traslado está ${transfer.status}: su acta ya se generó o está cerrado`);
      }
      const items = (await manager.query(
        `SELECT i.asset_id AS "assetId", i.reason_id AS "reasonId", i.physical_condition AS "physicalCondition",
                i.physically_verified AS "physicallyVerified", i.verification_note AS "verificationNote",
                i.numbering_present AS "numberingPresent", i.observations
         FROM asset_transfer_item i WHERE i.transfer_id = $1 ORDER BY i.line_number`,
        [id],
      )) as TransferItemInputDto[];
      if (items.length === 0) {
        throw new ApiException(ErrorCode.ValidationFailed, 'El traslado no tiene activos');
      }
      // Lo que se validó al crear sigue valiendo al generar (el activo pudo entrar a un préstamo o a una toma).
      await this.assertItems(manager, items, transfer.source_cost_center_id, id);
      const control = await this.signers.resolve('CONTROL', dto.controlSignerPersonId, manager);
      const accounting = await this.signers.resolve('ACCOUNTING', dto.accountingSignerPersonId, manager);
      const payload = await this.actPayload(manager, transfer, control, accounting, dto);
      const requestId = await this.engine.enqueue(manager, payload, actor.id);
      await manager.query(
        `UPDATE asset_transfer SET status = 'PENDING_SIGNATURES', document_request_id = $2, control_person_id = $3,
           accounting_person_id = $4, generated_by = $5, generated_at = NOW()
         WHERE id = $1`,
        [id, requestId, control, accounting, actor.id],
      );
      await this.audit(manager, AuditAction.TransferActRequested, id, actor.id, {
        documentRequestId: requestId,
        signers: payload.signers,
        responsiblePersonId: payload.responsiblePersonId,
        ...(payload.signerSubstitutions ? { signerSubstitutions: payload.signerSubstitutions } : {}),
      });
    }
  }

  private async actPayload(
    manager: EntityManager,
    transfer: TransferRow,
    control: string,
    accounting: string,
    dto: GenerateTransferActDto,
  ): Promise<DocumentRequestPayload> {
    const assets = (await manager.query(
      `SELECT a.id, a.model, a.serial_number, a.acquisition_document, to_char(a.acquisition_date, 'YYYY-MM-DD') AS acquisition_date,
              a.acquisition_price::text AS acquisition_price, i.physical_condition, i.physically_verified, i.verification_note,
              i.numbering_present, i.observations, r.name AS reason
       FROM asset_transfer_item i
       JOIN asset a ON a.id = i.asset_id
       JOIN asset_transfer_reason r ON r.id = i.reason_id
       WHERE i.transfer_id = $1 ORDER BY i.line_number`,
      [transfer.id],
    )) as Array<{
      id: string;
      model: string | null;
      serial_number: string | null;
      acquisition_document: string | null;
      acquisition_date: string | null;
      acquisition_price: string | null;
      physical_condition: string;
      physically_verified: boolean;
      verification_note: string | null;
      numbering_present: boolean;
      observations: string | null;
      reason: string;
    }>;
    const centers = (await manager.query('SELECT id, external_code, name FROM cost_center WHERE id = ANY($1)', [
      [transfer.source_cost_center_id, transfer.target_cost_center_id],
    ])) as Array<{ id: string; external_code: string; name: string }>;
    const source = centers.find((center) => center.id === transfer.source_cost_center_id);
    const target = centers.find((center) => center.id === transfer.target_cost_center_id);
    const label = (center: typeof source) => (center ? `${center.external_code} ${center.name}` : '');
    const targetUnit = await unitAt(manager, transfer.target_cost_center_id, new Date());
    const notes = Object.fromEntries(assets.filter((asset) => asset.observations).map((asset) => [asset.id, asset.observations ?? '']));
    return {
      formatKey: TRANSFER_FORMAT_KEY,
      entityType: TRANSFER_ENTITY_TYPE,
      entityId: transfer.id,
      // centroCosto.* del acta = centro que ENTREGA (con su unidad a la fecha del acta); el destino va en campos.
      costCenterId: transfer.source_cost_center_id,
      responsiblePersonId: transfer.owner_person_id,
      signers: { ENTREGA: transfer.requester_person_id, CONTROL_INTERNO: control, CONTABILIDAD: accounting },
      ...(dto.signerSubstitutions && Object.keys(dto.signerSubstitutions).length > 0
        ? { signerSubstitutions: dto.signerSubstitutions }
        : {}),
      assetIds: assets.map((asset) => asset.id),
      ...(Object.keys(notes).length > 0 ? { assetNotes: notes } : {}),
      assetFields: Object.fromEntries(
        assets.map((asset) => [
          asset.id,
          {
            modelo: asset.model ?? '',
            numeroDocumento: asset.acquisition_document ?? '',
            serie: asset.serial_number ?? '',
            centro: label(source),
            fechaCompra: asset.acquisition_date ?? '',
            precioCompra: money(asset.acquisition_price),
            fisico: yesNo(asset.physically_verified),
            verificacion: asset.verification_note ?? '',
            estado: CONDITION_LABELS[asset.physical_condition] ?? asset.physical_condition,
            numeracion: yesNo(asset.numbering_present),
            observaciones: asset.observations ?? '',
            motivo: asset.reason,
            traslado: label(target),
          },
        ]),
      ),
      fields: {
        centroOrigen: label(source),
        centroOrigenCodigo: source?.external_code ?? '',
        centroOrigenNombre: source?.name ?? '',
        centroDestino: label(target),
        centroDestinoCodigo: target?.external_code ?? '',
        centroDestinoNombre: target?.name ?? '',
        centroDestinoUnidadCodigo: targetUnit?.code ?? '',
        centroDestinoUnidadNombre: targetUnit?.name ?? '',
        justificacion: transfer.justification,
      },
    };
  }

  // ---------- Cancelar ----------

  /**
   * DRAFT, o PENDING_SIGNATURES sin ninguna firma: en una transacción la solicitud del acta queda CANCELLED o el acta
   * VOIDED (voidForEntity), el traslado CANCELLED con motivo y sus activos liberados. Con alguna firma ya puesta no se
   * cancela (quien firmó ya se comprometió): 406 TRANSFER_INVALID_STATE_TRANSITION. Orden de bloqueos: el acta
   * (voidForEntity) antes que el traslado, el mismo del job del outbox (fila de la solicitud → onGenerated).
   */
  async cancel(id: string, reason: string, actor: AuthenticatedUser): Promise<TransferDetailDto> {
    const motive = reason.trim();
    if (motive.length < 5) {
      throw new ApiException(ErrorCode.ValidationFailed, 'El motivo de la cancelación es obligatorio', [
        { field: 'reason', message: 'Mínimo 5 caracteres' },
      ]);
    }
    await this.dataSource.transaction(async (manager) => {
      const [exists] = (await manager.query('SELECT status FROM asset_transfer WHERE id = $1', [id])) as Array<{ status: TransferStatus }>;
      if (!exists) {
        throw new ApiException(ErrorCode.ResourceNotFound, 'No existe el traslado');
      }
      if (!canTransferTransition(exists.status, 'CANCELLED')) {
        throw new ApiException(ErrorCode.TransferInvalidStateTransition, `El traslado está ${exists.status} y no se puede cancelar`);
      }
      const [signed] = (await manager.query(
        `SELECT count(*)::int AS total FROM document_signature s JOIN document d ON d.id = s.document_id
         WHERE d.entity_type = $1 AND d.entity_id = $2 AND d.status = 'PENDING_SIGNATURE' AND s.status = 'SIGNED'`,
        [TRANSFER_ENTITY_TYPE, id],
      )) as Array<{ total: number }>;
      if ((signed?.total ?? 0) > 0) {
        throw new ApiException(
          ErrorCode.TransferInvalidStateTransition,
          'El acta del traslado ya tiene firmas: no se cancela. Un firmante puede rechazarla',
        );
      }
      const voided = await this.engine.voidForEntity(manager, {
        entityType: TRANSFER_ENTITY_TYPE,
        entityId: id,
        reason: motive,
        actorId: actor.id,
      });
      const transfer = await this.lock(manager, id);
      if (!canTransferTransition(transfer.status, 'CANCELLED')) {
        throw new ApiException(ErrorCode.TransferInvalidStateTransition, `El traslado está ${transfer.status} y no se puede cancelar`);
      }
      await manager.query(
        `UPDATE asset_transfer SET status = 'CANCELLED', cancelled_at = NOW(), cancelled_by = $2, cancel_reason = $3 WHERE id = $1`,
        [id, actor.id, motive],
      );
      await manager.query('UPDATE asset_transfer_item SET open = FALSE WHERE transfer_id = $1', [id]);
      await this.audit(manager, AuditAction.TransferCancelled, id, actor.id, {
        from: transfer.status,
        reason: motive,
        cancelledRequestIds: voided.cancelledRequestIds,
        voidedDocumentIds: voided.voidedDocumentIds,
      });
    });
    return this.detail(id);
  }

  // ---------- Validaciones ----------

  async lock(manager: EntityManager, id: string): Promise<TransferRow> {
    const [row] = UUID.test(id)
      ? ((await manager.query(
          `SELECT id, status, source_cost_center_id, target_cost_center_id, requester_person_id, owner_person_id,
                  control_person_id, document_request_id, document_id, created_by, justification
           FROM asset_transfer WHERE id = $1 FOR UPDATE`,
          [id],
        )) as TransferRow[])
      : [];
    if (!row) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'No existe el traslado');
    }
    return row;
  }

  private async assertPersons(manager: EntityManager, persons: ReadonlyArray<readonly [string, string, string]>): Promise<void> {
    const found = (await manager.query('SELECT id FROM person WHERE id = ANY($1)', [persons.map(([, id]) => id)])) as Array<{
      id: string;
    }>;
    const ids = new Set(found.map((item) => item.id));
    const missing: ErrorDetail[] = persons.filter(([, id]) => !ids.has(id)).map(([field, , message]) => ({ field, message }));
    if (missing.length > 0) {
      throw new ApiException(ErrorCode.ResourceNotFound, missing.map((item) => item.message).join('; '), missing);
    }
  }

  private async assertTarget(manager: EntityManager, source: string, targetId: string): Promise<void> {
    if (source === targetId) {
      throw new ApiException(ErrorCode.TransferSameCostCenter);
    }
    const [target] = (await manager.query(
      'SELECT id FROM cost_center WHERE id = $1 AND is_active AND accepts_assets',
      [targetId],
    )) as unknown[];
    if (!target) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'El centro de costo de destino no existe, está inactivo o no admite activos', [
        { field: 'targetCostCenterId', message: 'Centro de destino no disponible' },
      ]);
    }
  }

  /**
   * Bloquea los activos (FOR UPDATE, en orden de id) y aplica las guardas. expectedSource: el origen del traslado (al
   * editar o generar); null al crear, que lo toma de los activos. ownTransfer: el traslado que ya los contiene.
   * checkReasons false: al aplicar el acta firmada un motivo desactivado después no la frena.
   * Devuelve el centro de origen.
   */
  async assertItems(
    manager: EntityManager,
    items: ReadonlyArray<TransferItemInputDto>,
    expectedSource: string | null,
    ownTransfer: string | null = null,
    options: { readonly checkReasons?: boolean } = {},
  ): Promise<string> {
    const assetIds = items.map((item) => item.assetId);
    const repeated = assetIds.filter((id, index) => assetIds.indexOf(id) !== index);
    if (repeated.length > 0) {
      throw new ApiException(
        ErrorCode.ValidationFailed,
        'Un activo aparece más de una vez en el traslado',
        [...new Set(repeated)].map((id) => ({ field: 'items', message: `Activo repetido: ${id}` })),
      );
    }
    await manager.query('SELECT id FROM asset WHERE id = ANY($1) ORDER BY id FOR UPDATE', [assetIds]);
    const rows = (await manager.query(
      `SELECT a.id, ${ASSET_CODE} AS code, a.current_cost_center_id, a.operational_status::text AS operational_status,
              a.physical_condition::text AS physical_condition,
              (SELECT count(*)::int FROM physical_inventory_item pi JOIN physical_inventory p ON p.id = pi.inventory_id
                 WHERE pi.asset_id = a.id AND p.status IN ('PLANNED', 'IN_PROGRESS')) AS open_inventories,
              (SELECT count(*)::int FROM asset_loan_item li JOIN asset_loan l ON l.id = li.loan_id
                 WHERE li.asset_id = a.id AND l.status::text = ANY($2) AND li.received_at IS NULL) AS active_loans,
              (SELECT ti.transfer_id::text FROM asset_transfer_item ti
                 WHERE ti.asset_id = a.id AND ti.open AND ti.transfer_id IS DISTINCT FROM $3::uuid LIMIT 1) AS open_transfer
       FROM asset a WHERE a.id = ANY($1)`,
      [assetIds, OPEN_LOAN_STATUSES, ownTransfer],
    )) as AssetGuardRow[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const missing = assetIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new ApiException(
        ErrorCode.ResourceNotFound,
        'Hay activos inexistentes en el traslado',
        missing.map((id) => ({ field: 'items', message: `No existe el activo ${id}` })),
      );
    }
    const ordered = assetIds.map((id) => byId.get(id) as AssetGuardRow);
    const source = expectedSource ?? ordered[0]?.current_cost_center_id ?? '';
    const elsewhere = ordered.filter((row) => row.current_cost_center_id !== source);
    if (elsewhere.length > 0) {
      throw new ApiException(
        ErrorCode.TransferMixedSourceCostCenter,
        undefined,
        elsewhere.map((row) => ({ field: 'items', message: `El activo ${row.code} está en otro centro de costo` })),
      );
    }
    const fail = (code: ErrorCode, list: AssetGuardRow[], message: (row: AssetGuardRow) => string) => {
      if (list.length > 0) {
        throw new ApiException(code, undefined, list.map((row) => ({ field: 'items', message: message(row) })));
      }
    };
    fail(ErrorCode.AssetAlreadyWrittenOff, ordered.filter((row) => row.operational_status === 'WRITTEN_OFF'), (row) => `El activo ${row.code} está dado de baja`);
    fail(ErrorCode.AssetCannotBeModified, ordered.filter((row) => row.operational_status === 'ON_LOAN'), (row) => `El activo ${row.code} está en préstamo`);
    fail(ErrorCode.AssetUnderInventory, ordered.filter((row) => row.open_inventories > 0), (row) => `El activo ${row.code} está en una toma física abierta`);
    fail(ErrorCode.AssetHasActiveLoan, ordered.filter((row) => row.active_loans > 0), (row) => `El activo ${row.code} está en un préstamo abierto`);
    fail(
      ErrorCode.TransferAssetInOpenTransfer,
      ordered.filter((row) => row.open_transfer !== null),
      (row) => `El activo ${row.code} está en el traslado abierto ${row.open_transfer}`,
    );
    if (options.checkReasons === false) {
      return source;
    }
    const reasonIds = [...new Set(items.map((item) => item.reasonId))];
    const reasons = (await manager.query('SELECT id FROM asset_transfer_reason WHERE id = ANY($1) AND is_active', [reasonIds])) as Array<{
      id: string;
    }>;
    const unavailable = reasonIds.filter((id) => !reasons.some((reason) => reason.id === id));
    if (unavailable.length > 0) {
      throw new ApiException(
        ErrorCode.TransferReasonUnavailable,
        undefined,
        unavailable.map((id) => ({ field: 'items.reasonId', message: `Motivo inexistente o inactivo: ${id}` })),
      );
    }
    return source;
  }

  async audit(
    manager: EntityManager,
    action: AuditAction,
    transferId: string,
    actorId: string,
    changes: Record<string, unknown>,
  ): Promise<void> {
    await this.auditLogs.record(
      { action, entityType: TRANSFER_ENTITY_TYPE, entityId: transferId, performedBy: actorId, ipAddress: null, userAgent: null, changes },
      manager,
    );
  }
}
