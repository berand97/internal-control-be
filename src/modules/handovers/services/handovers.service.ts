import { Injectable, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, type EntityManager, QueryFailedError } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import type { ErrorDetail } from '../../../common/types/response-envelope.type.js';
import type { Asset } from '../../assets/entities/asset.entity.js';
import { MovementType } from '../../assets/enums/movement-type.enum.js';
import type { OperationalStatus } from '../../assets/enums/operational-status.enum.js';
import { AssetStateService } from '../../assets/services/asset-state.service.js';
import { AuditAction } from '../../auth/enums/audit-action.enum.js';
import {
  DocumentLifecycleRegistry,
  type DocumentLifecycleEvent,
} from '../../documents/lifecycle/document-lifecycle.registry.js';
import { DocumentEngineService } from '../../documents/services/document-engine.service.js';
import {
  HANDOVER_ENTITY_TYPE,
  HANDOVER_FORMAT_KEY,
  NOT_DELIVERABLE_STATUSES,
  type HandoverStatus,
} from '../domain/handover.js';
import type {
  CreateHandoverDto,
  HandoverDetailDto,
  HandoverDocumentDto,
  HandoverListItemDto,
  HandoverListResponseDto,
} from '../dto/handover.dto.js';

/** Reintentos automáticos del outbox (DocumentEngineService.processPending: attempts < 5). */
const AUTOMATIC_GENERATION_ATTEMPTS = 5;

interface HandoverRow {
  id: string;
  status: HandoverStatus;
  cost_center_id: string;
  receiver_person_id: string;
  auditor_person_id: string;
  assigned_person_id: string | null;
  document_request_id: string;
  document_id: string | null;
  created_by: string;
}

interface AssetCheckRow {
  id: string;
  current_cost_center_id: string;
  operational_status: OperationalStatus;
  code: string;
}

const PERSON_JSON = (alias: string) =>
  `CASE WHEN ${alias}.id IS NULL THEN NULL ELSE json_build_object('id', ${alias}.id,
     'name', trim(${alias}.first_name || ' ' || ${alias}.last_name), 'documentNumber', ${alias}.document_number) END`;

const ASSET_CODE = `coalesce(
  (SELECT value FROM asset_identifier i WHERE i.asset_id = a.id AND i.identifier_type = 'VISIBLE_CODE' AND i.valid_to IS NULL LIMIT 1),
  (SELECT value FROM asset_identifier i WHERE i.asset_id = a.id AND i.identifier_type = 'LEGACY_CODE' AND i.valid_to IS NULL ORDER BY i.created_at LIMIT 1),
  a.internal_code)`;

/**
 * Acta de entrega y asignación (OCI-01-55): el proceso por el que un activo obtiene responsable.
 *
 * Crear la entrega y encolar su acta van en una transacción; la generación es asíncrona (outbox) y un fallo de
 * generación no toca la entrega. Al firmarse el acta (onSigned, en la transacción que la pasa a SIGNED) cada activo
 * queda con el firmante RECIBE final como responsable, con un movimiento ASSIGNMENT enlazado al acta.
 */
@Injectable()
export class HandoversService implements OnModuleInit {
  constructor(
    private readonly dataSource: DataSource,
    private readonly engine: DocumentEngineService,
    private readonly lifecycle: DocumentLifecycleRegistry,
    private readonly assetState: AssetStateService,
  ) {}

  onModuleInit(): void {
    this.lifecycle.register({
      entityType: HANDOVER_ENTITY_TYPE,
      onGenerated: (manager, event) => this.onGenerated(manager, event),
      onSigned: (manager, event) => this.onSigned(manager, event),
      onRejected: (manager, event) => this.onRejected(manager, event),
    });
  }

  async create(dto: CreateHandoverDto, actor: AuthenticatedUser): Promise<HandoverDetailDto> {
    const assetIds = dto.assets.map((item) => item.assetId);
    const repeated = assetIds.filter((id, index) => assetIds.indexOf(id) !== index);
    if (repeated.length > 0) {
      throw new ApiException(
        ErrorCode.ValidationFailed,
        'Un activo aparece más de una vez en la entrega',
        [...new Set(repeated)].map((id) => ({ field: 'assets', message: `Activo repetido: ${id}` })),
      );
    }
    const handoverId = randomUUID();
    try {
      await this.dataSource.transaction(async (manager) => {
        await this.assertPersons(manager, dto);
        await this.assertCostCenter(manager, dto.costCenterId);
        await this.assertAssets(manager, assetIds, dto.costCenterId);
        await this.assertNotInOpenHandover(manager, assetIds);

        const assetNotes = Object.fromEntries(
          dto.assets.filter((item) => item.note?.trim()).map((item) => [item.assetId, (item.note ?? '').trim()]),
        );
        const requestId = await this.engine.enqueue(
          manager,
          {
            formatKey: HANDOVER_FORMAT_KEY,
            entityType: HANDOVER_ENTITY_TYPE,
            entityId: handoverId,
            costCenterId: dto.costCenterId,
            responsiblePersonId: dto.receiverPersonId,
            assetIds,
            signers: { AUDITA: dto.auditorPersonId },
            assetNotes,
          },
          actor.id,
        );
        await manager.query(
          `INSERT INTO asset_handover (id, cost_center_id, receiver_person_id, auditor_person_id, document_request_id, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [handoverId, dto.costCenterId, dto.receiverPersonId, dto.auditorPersonId, requestId, actor.id],
        );
        await manager.query(
          `INSERT INTO asset_handover_item (handover_id, asset_id, line_number, note)
           SELECT $1, item.asset_id, item.line_number, item.note
           FROM unnest($2::uuid[], $3::text[]) WITH ORDINALITY AS item(asset_id, note, line_number)`,
          [handoverId, assetIds, dto.assets.map((item) => item.note?.trim() || null)],
        );
      });
    } catch (error) {
      // Dos entregas concurrentes con el mismo activo: la segunda choca con el índice de entregas abiertas.
      if (error instanceof QueryFailedError && (error.driverError as { constraint?: string })?.constraint === 'uq_asset_handover_item_open') {
        throw new ApiException(ErrorCode.HandoverAssetInOpenHandover);
      }
      throw error;
    }
    return this.detail(handoverId);
  }

  async list(query: { readonly page: number; readonly pageSize: number; readonly status?: HandoverStatus }): Promise<HandoverListResponseDto> {
    const status = query.status ?? null;
    const [count] = (await this.dataSource.query(
      'SELECT count(*)::int AS total FROM asset_handover WHERE ($1::text IS NULL OR status = $1)',
      [status],
    )) as Array<{ total: number }>;
    const rows = (await this.dataSource.query(
      `SELECT h.id, h.status,
              json_build_object('id', cc.id, 'code', cc.external_code, 'name', cc.name) AS "costCenter",
              ${PERSON_JSON('rp')} AS receiver,
              ${PERSON_JSON('ap')} AS "assignedPerson",
              (SELECT count(*)::int FROM asset_handover_item i WHERE i.handover_id = h.id) AS "assetCount",
              r.status AS generation,
              CASE WHEN r.status = 'FAILED' THEN r.last_error END AS "generationError",
              h.document_id AS "documentId", d.number AS "documentNumber",
              h.created_at AS "createdAt", h.closed_at AS "closedAt"
       FROM asset_handover h
       JOIN cost_center cc ON cc.id = h.cost_center_id
       JOIN person rp ON rp.id = h.receiver_person_id
       LEFT JOIN person ap ON ap.id = h.assigned_person_id
       JOIN document_request r ON r.id = h.document_request_id
       LEFT JOIN document d ON d.id = h.document_id
       WHERE ($1::text IS NULL OR h.status = $1)
       ORDER BY h.created_at DESC, h.id DESC
       LIMIT $2 OFFSET $3`,
      [status, query.pageSize, (query.page - 1) * query.pageSize],
    )) as HandoverListItemDto[];
    const total = count?.total ?? 0;
    return { items: rows, page: query.page, pageSize: query.pageSize, total, hasNext: query.page * query.pageSize < total };
  }

  async detail(id: string, manager: EntityManager = this.dataSource.manager): Promise<HandoverDetailDto> {
    const [row] = (await manager.query(
      `SELECT h.id, h.status, h.document_request_id, h.document_id,
              json_build_object('id', cc.id, 'code', cc.external_code, 'name', cc.name) AS "costCenter",
              ${PERSON_JSON('rp')} AS receiver,
              ${PERSON_JSON('au')} AS auditor,
              ${PERSON_JSON('ap')} AS "assignedPerson",
              json_build_object('userId', u.id, 'name', nullif(trim(concat_ws(' ', up.first_name, up.last_name)), '')) AS "createdBy",
              h.created_at AS "createdAt", h.closed_at AS "closedAt"
       FROM asset_handover h
       JOIN cost_center cc ON cc.id = h.cost_center_id
       JOIN person rp ON rp.id = h.receiver_person_id
       JOIN person au ON au.id = h.auditor_person_id
       LEFT JOIN person ap ON ap.id = h.assigned_person_id
       JOIN app_user u ON u.id = h.created_by
       LEFT JOIN person up ON up.id = u.person_id
       WHERE h.id = $1`,
      [id],
    )) as Array<
      Omit<HandoverDetailDto, 'items' | 'document'> & { document_request_id: string; document_id: string | null }
    >;
    if (!row) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'No existe la entrega');
    }
    const items = (await manager.query(
      `SELECT i.line_number AS "lineNumber", i.note, i.movement_id AS "movementId",
              json_build_object('id', a.id, 'code', ${ASSET_CODE}, 'description', a.description,
                'operationalStatus', a.operational_status, 'responsibleId', a.current_responsible_id) AS asset
       FROM asset_handover_item i JOIN asset a ON a.id = i.asset_id
       WHERE i.handover_id = $1 ORDER BY i.line_number`,
      [id],
    )) as HandoverDetailDto['items'];
    const { document_request_id: requestId, document_id: documentId, ...handover } = row;
    return { ...handover, items, document: await this.documentState(id, requestId, documentId, manager) };
  }

  private async documentState(
    handoverId: string,
    requestId: string,
    documentId: string | null,
    manager: EntityManager,
  ): Promise<HandoverDocumentDto> {
    const state = await this.lifecycle.stateFor(HANDOVER_ENTITY_TYPE, handoverId, { formatKey: HANDOVER_FORMAT_KEY, manager });
    const request = state.requests.find((item) => item.requestId === requestId);
    const document = documentId ? state.documents.find((item) => item.documentId === documentId) : undefined;
    const signatures = documentId
      ? ((await manager.query(
          `SELECT sign_order AS "order", role, signer_person_id AS "personId", signer_name AS name, status, signed_at AS "signedAt"
           FROM document_signature WHERE document_id = $1 ORDER BY sign_order`,
          [documentId],
        )) as HandoverDocumentDto['signatures'])
      : [];
    const failed = request?.status === 'FAILED';
    return {
      generation: state.generation,
      requestId,
      attempts: request?.attempts ?? 0,
      lastError: failed ? (request?.lastError ?? null) : null,
      retriesAutomatically: failed && (request?.attempts ?? 0) < AUTOMATIC_GENERATION_ATTEMPTS,
      retryable: failed && !request?.documentId,
      documentId,
      number: document?.number ?? null,
      status: document?.status ?? null,
      signedAt: document?.signedAt ? new Date(document.signedAt).toISOString() : null,
      lifecycleError: document?.lifecycleError ?? null,
      signatures,
    };
  }

  // ---------- Validaciones de la solicitud ----------

  private async assertPersons(manager: EntityManager, dto: CreateHandoverDto): Promise<void> {
    const found = (await manager.query('SELECT id FROM person WHERE id = ANY($1)', [
      [dto.receiverPersonId, dto.auditorPersonId],
    ])) as Array<{ id: string }>;
    const ids = new Set(found.map((item) => item.id));
    const missing: ErrorDetail[] = [
      ...(ids.has(dto.receiverPersonId) ? [] : [{ field: 'receiverPersonId', message: 'No existe la persona que recibe' }]),
      ...(ids.has(dto.auditorPersonId) ? [] : [{ field: 'auditorPersonId', message: 'No existe la persona de Control Interno' }]),
    ];
    if (missing.length > 0) {
      throw new ApiException(ErrorCode.ResourceNotFound, missing.map((item) => item.message).join('; '), missing);
    }
  }

  private async assertCostCenter(manager: EntityManager, costCenterId: string): Promise<void> {
    const [found] = (await manager.query('SELECT id FROM cost_center WHERE id = $1', [costCenterId])) as unknown[];
    if (!found) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'No existe el centro de costo', [
        { field: 'costCenterId', message: 'No existe el centro de costo' },
      ]);
    }
  }

  /** Bloquea los activos (FOR SHARE) hasta el commit: su estado y centro no cambian mientras se crea la entrega. */
  private async assertAssets(manager: EntityManager, assetIds: ReadonlyArray<string>, costCenterId: string): Promise<void> {
    const rows = (await manager.query(
      `SELECT a.id, a.current_cost_center_id, a.operational_status, ${ASSET_CODE} AS code
       FROM asset a WHERE a.id = ANY($1) ORDER BY a.id FOR SHARE OF a`,
      [assetIds],
    )) as AssetCheckRow[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const missing = assetIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new ApiException(
        ErrorCode.ResourceNotFound,
        'Hay activos inexistentes en la entrega',
        missing.map((id) => ({ field: 'assets', message: `No existe el activo ${id}` })),
      );
    }
    const blocked = rows.filter((row) => NOT_DELIVERABLE_STATUSES.includes(row.operational_status));
    if (blocked.length > 0) {
      throw new ApiException(
        ErrorCode.HandoverAssetNotDeliverable,
        undefined,
        blocked.map((row) => ({ field: 'assets', message: `El activo ${row.code} (${row.id}) está ${row.operational_status}` })),
      );
    }
    const elsewhere = rows.filter((row) => row.current_cost_center_id !== costCenterId);
    if (elsewhere.length > 0) {
      throw new ApiException(
        ErrorCode.HandoverCostCenterMismatch,
        undefined,
        elsewhere.map((row) => ({
          field: 'assets',
          message: `El activo ${row.code} (${row.id}) está en el centro de costo ${row.current_cost_center_id}`,
        })),
      );
    }
  }

  private async assertNotInOpenHandover(manager: EntityManager, assetIds: ReadonlyArray<string>): Promise<void> {
    const open = (await manager.query(
      `SELECT i.asset_id, i.handover_id FROM asset_handover_item i WHERE i.open AND i.asset_id = ANY($1)`,
      [assetIds],
    )) as Array<{ asset_id: string; handover_id: string }>;
    if (open.length > 0) {
      throw new ApiException(
        ErrorCode.HandoverAssetInOpenHandover,
        undefined,
        open.map((row) => ({ field: 'assets', message: `El activo ${row.asset_id} está en la entrega abierta ${row.handover_id}` })),
      );
    }
  }

  // ---------- Ciclo de vida del acta ----------

  private async lockFor(manager: EntityManager, event: DocumentLifecycleEvent): Promise<HandoverRow> {
    if (event.formatKey !== HANDOVER_FORMAT_KEY) {
      throw new Error(`El acta ${event.number} es ${event.formatKey}, no ${HANDOVER_FORMAT_KEY}`);
    }
    const [handover] = event.entityId
      ? ((await manager.query(
          `SELECT id, status, cost_center_id, receiver_person_id, auditor_person_id, assigned_person_id,
                  document_request_id, document_id, created_by
           FROM asset_handover WHERE id = $1 FOR UPDATE`,
          [event.entityId],
        )) as HandoverRow[])
      : [];
    if (!handover) {
      throw new Error(`No existe la entrega ${event.entityId ?? '(sin id)'} del acta ${event.number}`);
    }
    return handover;
  }

  /** Corre en la transacción que inserta el acta: la entrega la adopta solo si todavía no tiene una. */
  private async onGenerated(manager: EntityManager, event: DocumentLifecycleEvent): Promise<void> {
    const handover = await this.lockFor(manager, event);
    if (handover.status !== 'AWAITING_DOCUMENT' || handover.document_id !== null) {
      throw new Error(`La entrega ${handover.id} ya tiene acta (${handover.document_id ?? handover.status})`);
    }
    await manager.query(`UPDATE asset_handover SET document_id = $2, status = 'PENDING_SIGNATURE' WHERE id = $1`, [
      handover.id,
      event.documentId,
    ]);
  }

  /**
   * Corre en la transacción que pasa el acta a SIGNED. El responsable asignado es el firmante RECIBE final (el
   * turno pudo reasignarse y el acta se re-emitió con ese nombre), nunca el receptor original de la solicitud.
   */
  private async onSigned(manager: EntityManager, event: DocumentLifecycleEvent): Promise<void> {
    const handover = await this.lockFor(manager, event);
    this.assertExpectedDocument(handover, event);
    const receiver = event.signersByRole['RECIBE'];
    if (!receiver) {
      throw new Error(`El acta ${event.number} no tiene firmante RECIBE`);
    }
    // Quien autoriza el movimiento es quien firmó por Control Interno (si tiene usuario); si no, quien creó la entrega.
    const auditorPerson = event.signersByRole['AUDITA'] ?? null;
    const [auditorUser] = auditorPerson
      ? ((await manager.query('SELECT id FROM app_user WHERE person_id = $1', [auditorPerson])) as Array<{ id: string }>)
      : [];
    const authorizedBy = auditorUser?.id ?? handover.created_by;

    const items = (await manager.query(
      'SELECT asset_id FROM asset_handover_item WHERE handover_id = $1 ORDER BY asset_id',
      [handover.id],
    )) as Array<{ asset_id: string }>;
    for (const { asset_id: assetId } of items) {
      await this.assetState.apply(
        {
          assetId,
          actorId: authorizedBy,
          patch: { responsibleId: receiver },
          movement: {
            type: MovementType.Assignment,
            reason: `Acta de entrega y asignación ${HANDOVER_FORMAT_KEY} No. ${event.number}`,
            documentReference: event.number,
            requestedBy: handover.created_by,
            metadata: { handoverId: handover.id, documentId: event.documentId },
          },
          guard: (current: Asset) => this.assertStillDeliverable(current, handover.cost_center_id),
          alsoWrite: async (tx) => {
            const [movement] = (await tx.query(
              `SELECT id FROM asset_movement
               WHERE asset_id = $1 AND movement_type = 'ASSIGNMENT' AND metadata->>'handoverId' = $2 AND metadata->>'documentId' = $3`,
              [assetId, handover.id, event.documentId],
            )) as Array<{ id: string }>;
            if (!movement) {
              throw new Error(`No quedó el movimiento de asignación del activo ${assetId}`);
            }
            await tx.query(
              'UPDATE asset_handover_item SET movement_id = $3, open = FALSE WHERE handover_id = $1 AND asset_id = $2',
              [handover.id, assetId, movement.id],
            );
            const linked = (await tx.query(
              `WITH linked AS (
                 UPDATE document_asset SET movement_id = $3
                 WHERE document_id = $1 AND asset_id = $2 AND movement_id IS NULL RETURNING asset_id
               ) SELECT asset_id FROM linked`,
              [event.documentId, assetId, movement.id],
            )) as unknown[];
            if (linked.length !== 1) {
              throw new Error(`El acta ${event.number} no tiene al activo ${assetId} pendiente de enlazar a su movimiento`);
            }
          },
          audit: {
            action: AuditAction.AssetUpdated,
            changes: {
              responsibleId: { to: receiver },
              handoverId: handover.id,
              documentId: event.documentId,
              documentNumber: event.number,
            },
          },
        },
        manager,
      );
    }
    await manager.query(
      `UPDATE asset_handover SET status = 'SIGNED', assigned_person_id = $2, closed_at = NOW() WHERE id = $1`,
      [handover.id, receiver],
    );
  }

  /** Corre en la transacción que pasa el acta a REJECTED: la entrega se cierra sin tocar activos. */
  private async onRejected(manager: EntityManager, event: DocumentLifecycleEvent): Promise<void> {
    const handover = await this.lockFor(manager, event);
    this.assertExpectedDocument(handover, event);
    await manager.query(`UPDATE asset_handover SET status = 'REJECTED', closed_at = NOW() WHERE id = $1`, [handover.id]);
    await manager.query('UPDATE asset_handover_item SET open = FALSE WHERE handover_id = $1', [handover.id]);
  }

  private assertExpectedDocument(handover: HandoverRow, event: DocumentLifecycleEvent): void {
    if (handover.document_id !== event.documentId) {
      throw new Error(`El acta ${event.number} (${event.documentId}) no es la de la entrega ${handover.id} (${handover.document_id ?? 'sin acta'})`);
    }
    if (handover.status !== 'PENDING_SIGNATURE') {
      throw new Error(`La entrega ${handover.id} está ${handover.status}, no pendiente de firma`);
    }
  }

  /** Lo que se validó al crear la entrega sigue valiendo al aplicarla: si cambió, el acta no se aplica y queda visible. */
  private assertStillDeliverable(current: Asset, costCenterId: string): void {
    if (NOT_DELIVERABLE_STATUSES.includes(current.operationalStatus)) {
      throw new ApiException(
        ErrorCode.HandoverAssetNotDeliverable,
        `El activo ${current.internalCode} está ${current.operationalStatus}; la entrega no se aplica`,
      );
    }
    if (current.costCenterId !== costCenterId) {
      throw new ApiException(
        ErrorCode.HandoverCostCenterMismatch,
        `El activo ${current.internalCode} cambió de centro de costo; la entrega no se aplica`,
      );
    }
  }
}
