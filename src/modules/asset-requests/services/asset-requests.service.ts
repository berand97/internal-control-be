import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager, QueryFailedError } from 'typeorm';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { ApiException } from '../../../common/exceptions/api.exception.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { DocumentEngineService } from '../../documents/services/document-engine.service.js';
import { LOAN_DELIVERY_FORMAT } from '../../loans/domain/loan-documents.js';
import { OPEN_LOAN_STATUSES } from '../../loans/enums/loan-status.js';
import { LoansService } from '../../loans/services/loans.service.js';
import { QrTokensService } from '../../qr-tokens/services/qr-tokens.service.js';
import { PermissionsService } from '../../roles/services/permissions.service.js';
import { TRANSFER_FORMAT_KEY } from '../../transfers/domain/transfer.js';
import { TransferSignersService } from '../../transfers/services/transfer-signers.service.js';
import { TransfersService } from '../../transfers/services/transfers.service.js';
import {
  ASSET_REQUEST_EXPIRY_DAYS,
  ASSET_REQUEST_REVIEW,
  assertAssetRequestTransition,
  type AssetRequestKind,
  type AssetRequestStatus,
  statusAfterCorrection,
} from '../domain/asset-request.js';
import type {
  AcceptAssetRequestDto,
  CorrectAssetRequestDto,
  CreateAssetRequestDto,
  EligibleAssetsQueryDto,
  GenerateAssetRequestDto,
  QueryAssetRequestsDto,
} from '../dto/asset-request.dto.js';
import type {
  AssetRequestDetailDto,
  AssetRequestListResponseDto,
  AssetRequestViewerRole,
  EligibleAssetDto,
  OwnerAvailabilityDto,
  ResolvedScanDto,
} from '../dto/asset-request.responses.js';
import { type AssetRequestAudience, AssetRequestNoticesService } from './asset-request-notices.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ASSET_CODE = `coalesce(
  (SELECT value FROM asset_identifier i WHERE i.asset_id = a.id AND i.identifier_type = 'VISIBLE_CODE' AND i.valid_to IS NULL LIMIT 1),
  (SELECT value FROM asset_identifier i WHERE i.asset_id = a.id AND i.identifier_type = 'LEGACY_CODE' AND i.valid_to IS NULL ORDER BY i.created_at LIMIT 1),
  a.internal_code)`;

const CURRENT_HEAD = `h.valid_from <= NOW() AND (h.valid_until IS NULL OR h.valid_until > NOW())`;

/**
 * Motivos por los que un activo del centro dueño no se puede elegir. Mismas guardas que el préstamo (estado IN_USE o
 * IN_STORAGE, sin préstamo abierto) y que el traslado (sin traslado abierto ni toma física abierta), más: no reservado
 * por otra solicitud abierta. $2 = OPEN_LOAN_STATUSES, $3 = solicitud propia (se excluye).
 */
const BLOCKERS = `ARRAY_REMOVE(ARRAY[
  CASE WHEN a.operational_status::text NOT IN ('IN_USE', 'IN_STORAGE') THEN 'está ' || a.operational_status::text END,
  CASE WHEN EXISTS (SELECT 1 FROM asset_loan_item li JOIN asset_loan l ON l.id = li.loan_id
         WHERE li.asset_id = a.id AND l.status::text = ANY($2) AND li.received_at IS NULL) THEN 'está en un préstamo abierto' END,
  CASE WHEN EXISTS (SELECT 1 FROM asset_transfer_item ti WHERE ti.asset_id = a.id AND ti.open)
       THEN 'está en un traslado abierto' END,
  CASE WHEN EXISTS (SELECT 1 FROM physical_inventory_item pi JOIN physical_inventory p ON p.id = pi.inventory_id
         WHERE pi.asset_id = a.id AND p.status IN ('PLANNED', 'IN_PROGRESS')) THEN 'está en una toma física abierta' END,
  CASE WHEN EXISTS (SELECT 1 FROM asset_request_item ri WHERE ri.asset_id = a.id AND ri.open AND ri.request_id IS DISTINCT FROM $3::uuid)
       THEN 'está reservado por otra solicitud' END
], NULL)`;

export interface AssetRequestRow {
  id: string;
  code: string;
  kind: AssetRequestKind;
  status: AssetRequestStatus;
  requester_user_id: string;
  requester_person_id: string;
  requesting_cost_center_id: string;
  owner_cost_center_id: string;
  description: string;
  note: string | null;
  start_date: string | null;
  expected_return_date: string | null;
  accepted_by: string | null;
  accepted_at: Date | null;
  loan_id: string | null;
  transfer_id: string | null;
}

const ROW_COLUMNS = `id, code, kind, status, requester_user_id, requester_person_id, requesting_cost_center_id,
  owner_cost_center_id, description, note, to_char(start_date, 'YYYY-MM-DD') AS start_date,
  to_char(expected_return_date, 'YYYY-MM-DD') AS expected_return_date, accepted_by, accepted_at, loan_id, transfer_id`;

const USER_JSON = (user: string, person: string) =>
  `CASE WHEN ${user}.id IS NULL THEN NULL ELSE
     json_build_object('userId', ${user}.id, 'name', nullif(trim(concat_ws(' ', ${person}.first_name, ${person}.last_name)), '')) END`;

const CENTER_JSON = (alias: string) => `json_build_object('id', ${alias}.id, 'code', ${alias}.external_code, 'name', ${alias}.name)`;

const SUMMARY_SELECT = `
  SELECT r.id, r.code, r.kind, r.status,
         ${CENTER_JSON('rc')} AS "requestingCostCenter", ${CENTER_JSON('oc')} AS "ownerCostCenter",
         ${USER_JSON('ru', 'rp')} AS requester, r.description,
         (SELECT count(*)::int FROM asset_request_item i WHERE i.request_id = r.id) AS "assetCount",
         r.expires_at AS "expiresAt", r.created_at AS "createdAt", r.updated_at AS "updatedAt"
  FROM asset_request r
  JOIN cost_center rc ON rc.id = r.requesting_cost_center_id
  JOIN cost_center oc ON oc.id = r.owner_cost_center_id
  JOIN app_user ru ON ru.id = r.requester_user_id
  LEFT JOIN person rp ON rp.id = ru.person_id`;

const iso = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString());

const longDate = (date: Date): string =>
  new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Bogota' }).format(date);

/**
 * Solicitud de activos entre centros de costo (domain/asset-request.ts). Reglas de quién:
 * - solicita: un usuario cuya persona es jefe VIGENTE del centro que solicita (cost_center_head);
 * - acepta o cierra: un jefe vigente del centro dueño que no sea quien solicitó (separación de funciones);
 * - revisa (devuelve o genera): asset_request:review:global; generar exige además el permiso de generación del formato
 *   (OCI-01-65 o OCI-17-89), el mismo que pide generarlo por su propio proceso.
 * Privacidad: nadie ve activos de otro centro. Una solicitud solo la ven sus partes (solicitante, jefes del dueño,
 * revisores); los activos elegibles y la lectura de QR, solo el jefe dueño y solo del centro dueño. Cualquier otro caso
 * responde 404 RESOURCE_NOT_FOUND, igual que una solicitud o un activo inexistentes.
 */
@Injectable()
export class AssetRequestsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly permissions: PermissionsService,
    private readonly notices: AssetRequestNoticesService,
    private readonly loans: LoansService,
    private readonly transfers: TransfersService,
    private readonly signers: TransferSignersService,
    private readonly documents: DocumentEngineService,
    private readonly qr: QrTokensService,
  ) {}

  // ---------- Quién ----------

  private async isHead(manager: EntityManager, userId: string, costCenterId: string): Promise<boolean> {
    const [row] = (await manager.query(
      `SELECT 1 FROM cost_center_head h JOIN app_user u ON u.person_id = h.person_id
       WHERE u.id = $1 AND h.cost_center_id = $2 AND ${CURRENT_HEAD}`,
      [userId, costCenterId],
    )) as unknown[];
    return row !== undefined;
  }

  private async headedCenters(userId: string): Promise<string[]> {
    const rows = (await this.dataSource.query(
      `SELECT DISTINCT h.cost_center_id FROM cost_center_head h JOIN app_user u ON u.person_id = h.person_id
       WHERE u.id = $1 AND ${CURRENT_HEAD}`,
      [userId],
    )) as Array<{ cost_center_id: string }>;
    return rows.map((row) => row.cost_center_id);
  }

  private isReviewer(userId: string): Promise<boolean> {
    return this.permissions.userHasPermission(userId, ASSET_REQUEST_REVIEW);
  }

  /** Jefes vigentes (persona activa) del centro, sin contar a la persona indicada. */
  private async headCount(manager: EntityManager, costCenterId: string, exceptPersonId: string | null): Promise<number> {
    const [row] = (await manager.query(
      `SELECT count(DISTINCT h.person_id)::int AS total FROM cost_center_head h JOIN person p ON p.id = h.person_id AND p.is_active
       WHERE h.cost_center_id = $1 AND ${CURRENT_HEAD} AND h.person_id IS DISTINCT FROM $2::uuid`,
      [costCenterId, exceptPersonId],
    )) as Array<{ total: number }>;
    return row?.total ?? 0;
  }

  private async roles(manager: EntityManager, request: AssetRequestRow, userId: string): Promise<AssetRequestViewerRole[]> {
    const roles: AssetRequestViewerRole[] = [];
    if (request.requester_user_id === userId) {
      roles.push('REQUESTER');
    }
    if (await this.isHead(manager, userId, request.owner_cost_center_id)) {
      roles.push('OWNER_HEAD');
    }
    if (await this.isReviewer(userId)) {
      roles.push('REVIEWER');
    }
    return roles;
  }

  private async row(manager: EntityManager, id: string, lock: boolean): Promise<AssetRequestRow | undefined> {
    if (!UUID.test(id)) {
      return undefined;
    }
    const [row] = (await manager.query(
      `SELECT ${ROW_COLUMNS} FROM asset_request WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
      [id],
    )) as AssetRequestRow[];
    return row;
  }

  /** La solicitud si el usuario es parte; si no (o no existe), 404 sin distinguir. */
  private async partyRequest(
    manager: EntityManager,
    id: string,
    userId: string,
    lock = false,
  ): Promise<{ request: AssetRequestRow; roles: AssetRequestViewerRole[] }> {
    const request = await this.row(manager, id, lock);
    const roles = request ? await this.roles(manager, request, userId) : [];
    if (!request || roles.length === 0) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'No existe la solicitud');
    }
    return { request, roles };
  }

  /** Acción del jefe dueño: 403 si no lo es; 403 SOD si además es quien solicitó. */
  private assertOwnerHead(request: AssetRequestRow, roles: ReadonlyArray<AssetRequestViewerRole>, userId: string): void {
    if (!roles.includes('OWNER_HEAD')) {
      throw new ApiException(ErrorCode.AssetRequestNotHead, 'Solo un jefe vigente del centro dueño decide la solicitud');
    }
    if (request.requester_user_id === userId) {
      throw new ApiException(ErrorCode.AssetRequestSodViolation);
    }
  }

  private assertRequester(roles: ReadonlyArray<AssetRequestViewerRole>): void {
    if (!roles.includes('REQUESTER')) {
      throw new ApiException(ErrorCode.InsufficientPermissions, 'Solo quien hizo la solicitud puede corregirla o cancelarla');
    }
  }

  private assertReviewer(roles: ReadonlyArray<AssetRequestViewerRole>): void {
    if (!roles.includes('REVIEWER')) {
      throw new ApiException(ErrorCode.InsufficientPermissions, `Requiere permiso ${ASSET_REQUEST_REVIEW}`);
    }
  }

  // ---------- Crear ----------

  async ownerAvailability(costCenterId: string, actor: AuthenticatedUser): Promise<OwnerAvailabilityDto> {
    const person = await this.personOf(this.dataSource.manager, actor.id);
    const total = await this.headCount(this.dataSource.manager, costCenterId, person);
    return total > 0
      ? { hasHead: true, message: 'El centro tiene jefe vigente que puede decidir la solicitud' }
      : {
          hasHead: false,
          message:
            'El centro no tiene jefe vigente que pueda decidir la solicitud: no se puede enviar. Pídale al administrador que asigne la jefatura',
        };
  }

  private async personOf(manager: EntityManager, userId: string): Promise<string | null> {
    const [row] = (await manager.query('SELECT person_id FROM app_user WHERE id = $1', [userId])) as Array<{
      person_id: string | null;
    }>;
    return row?.person_id ?? null;
  }

  private assertDates(kind: AssetRequestKind, startDate: string | null, expectedReturnDate: string | null): void {
    if (kind !== 'TEMPORARY') {
      return;
    }
    if (!startDate || !expectedReturnDate) {
      throw new ApiException(ErrorCode.ValidationFailed, 'Un préstamo temporal necesita fecha de inicio y de devolución', [
        ...(startDate ? [] : [{ field: 'startDate', message: 'Obligatoria en un préstamo temporal' }]),
        ...(expectedReturnDate ? [] : [{ field: 'expectedReturnDate', message: 'Obligatoria en un préstamo temporal' }]),
      ]);
    }
    if (expectedReturnDate < startDate) {
      throw new ApiException(ErrorCode.ValidationFailed, 'La devolución no puede ser anterior al inicio', [
        { field: 'expectedReturnDate', message: 'Anterior a startDate' },
      ]);
    }
  }

  /** Centros válidos: distintos, existentes y activos; quien solicita es jefe del que solicita; el dueño tiene jefe. */
  private async assertCenters(
    manager: EntityManager,
    actorId: string,
    personId: string,
    requestingCostCenterId: string,
    ownerCostCenterId: string,
  ): Promise<void> {
    if (requestingCostCenterId === ownerCostCenterId) {
      throw new ApiException(ErrorCode.ValidationFailed, 'El centro que solicita y el centro dueño deben ser distintos', [
        { field: 'ownerCostCenterId', message: 'Igual al centro que solicita' },
      ]);
    }
    const centers = (await manager.query('SELECT id FROM cost_center WHERE id = ANY($1) AND is_active', [
      [requestingCostCenterId, ownerCostCenterId],
    ])) as Array<{ id: string }>;
    if (centers.length !== 2) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'El centro de costo no existe o está inactivo');
    }
    if (!(await this.isHead(manager, actorId, requestingCostCenterId))) {
      throw new ApiException(
        ErrorCode.AssetRequestNotHead,
        'Solo un jefe vigente del centro que solicita puede pedir activos en su nombre',
      );
    }
    if ((await this.headCount(manager, ownerCostCenterId, personId)) === 0) {
      throw new ApiException(ErrorCode.AssetRequestOwnerWithoutHead);
    }
  }

  async create(dto: CreateAssetRequestDto, actor: AuthenticatedUser): Promise<AssetRequestDetailDto> {
    const startDate = dto.kind === 'TEMPORARY' ? (dto.startDate ?? null) : null;
    const expectedReturnDate = dto.kind === 'TEMPORARY' ? (dto.expectedReturnDate ?? null) : null;
    this.assertDates(dto.kind, startDate, expectedReturnDate);
    const id = await this.dataSource.transaction(async (manager) => {
      const personId = await this.personOf(manager, actor.id);
      if (!personId) {
        throw new ApiException(ErrorCode.AssetRequestNotHead, 'El usuario no tiene persona asociada: no es jefe de ningún centro');
      }
      await this.assertCenters(manager, actor.id, personId, dto.requestingCostCenterId, dto.ownerCostCenterId);
      const code = await this.nextCode(manager);
      const [created] = (await manager.query(
        `INSERT INTO asset_request (code, kind, requester_user_id, requester_person_id, requesting_cost_center_id,
           owner_cost_center_id, description, note, start_date, expected_return_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [
          code,
          dto.kind,
          actor.id,
          personId,
          dto.requestingCostCenterId,
          dto.ownerCostCenterId,
          dto.description.trim(),
          dto.note?.trim() || null,
          startDate,
          expectedReturnDate,
        ],
      )) as Array<{ id: string }>;
      const requestId = created?.id ?? '';
      await this.event(manager, requestId, 'CREATED', null, 'REQUESTED', actor.id, null, { kind: dto.kind });
      await this.notices.send(manager, requestId, 'CREATED', ['OWNER_HEADS']);
      return requestId;
    });
    return this.detail(id, ['REQUESTER']);
  }

  private async nextCode(manager: EntityManager): Promise<string> {
    const [row] = (await manager.query(
      `UPDATE code_sequence SET current_value = current_value + 1, updated_at = NOW()
       WHERE sequence_name = 'asset_request' RETURNING current_value, padding_length, prefix`,
    )) as [Array<{ current_value: string; padding_length: number; prefix: string | null }>, number];
    const reserved = row?.[0];
    if (!reserved) {
      throw new Error("Falta la secuencia 'asset_request' en code_sequence");
    }
    const year = new Intl.DateTimeFormat('en', { year: 'numeric', timeZone: 'America/Bogota' }).format(new Date());
    return `${reserved.prefix ?? 'SOL-'}${year}-${String(reserved.current_value).padStart(reserved.padding_length, '0')}`;
  }

  // ---------- Decisión del dueño ----------

  async accept(id: string, dto: AcceptAssetRequestDto, actor: AuthenticatedUser): Promise<AssetRequestDetailDto> {
    await this.dataSource.transaction(async (manager) => {
      const { request, roles } = await this.partyRequest(manager, id, actor.id, true);
      this.assertOwnerHead(request, roles, actor.id);
      assertAssetRequestTransition(request.status, 'ACCEPTED');
      const assetIds = [...new Set(dto.assetIds)];
      await this.assertEligible(manager, request, assetIds);
      try {
        await manager.query(
          `INSERT INTO asset_request_item (request_id, asset_id) SELECT $1, unnest($2::uuid[])`,
          [request.id, assetIds],
        );
      } catch (error) {
        if (error instanceof QueryFailedError && (error.driverError as { constraint?: string })?.constraint === 'uq_asset_request_item_open') {
          throw new ApiException(ErrorCode.AssetRequestAssetUnavailable, 'Otro jefe reservó uno de los activos al mismo tiempo');
        }
        throw error;
      }
      await manager.query(
        `UPDATE asset_request SET status = 'ACCEPTED', accepted_by = $2, accepted_at = NOW(), decided_by = $2, decided_at = NOW(),
           expires_at = NOW() + make_interval(days => $3) WHERE id = $1`,
        [request.id, actor.id, ASSET_REQUEST_EXPIRY_DAYS],
      );
      await this.event(manager, request.id, 'ACCEPTED', request.status, 'ACCEPTED', actor.id, dto.note?.trim() || null, {
        assetIds,
        assetCount: assetIds.length,
      });
      await this.notices.send(manager, request.id, 'ACCEPTED', ['REQUESTER', 'REVIEWERS'], { assetCount: assetIds.length });
    });
    return this.getById(id, actor);
  }

  /**
   * Los activos elegidos (filas bloqueadas): todos del centro dueño (si alguno no existe o es de otro centro, 404 como
   * inexistente, sin decir cuál) y elegibles (si no, 406 ASSET_REQUEST_ASSET_UNAVAILABLE con el motivo por activo).
   */
  private async assertEligible(manager: EntityManager, request: AssetRequestRow, assetIds: ReadonlyArray<string>): Promise<void> {
    await manager.query('SELECT id FROM asset WHERE id = ANY($1) ORDER BY id FOR UPDATE', [assetIds]);
    const rows = (await manager.query(
      `SELECT a.id, ${ASSET_CODE} AS code, ${BLOCKERS} AS blockers
       FROM asset a WHERE a.id = ANY($1) AND a.current_cost_center_id = $4`,
      [assetIds, OPEN_LOAN_STATUSES, request.id, request.owner_cost_center_id],
    )) as Array<{ id: string; code: string; blockers: string[] }>;
    if (rows.length !== assetIds.length) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'Hay activos que no existen');
    }
    const blocked = rows.filter((row) => row.blockers.length > 0);
    if (blocked.length > 0) {
      throw new ApiException(
        ErrorCode.AssetRequestAssetUnavailable,
        undefined,
        blocked.map((row) => ({ field: 'assetIds', message: `El activo ${row.code} ${row.blockers.join(', ')}` })),
      );
    }
  }

  async close(id: string, reason: string, actor: AuthenticatedUser): Promise<AssetRequestDetailDto> {
    await this.dataSource.transaction(async (manager) => {
      const { request, roles } = await this.partyRequest(manager, id, actor.id, true);
      this.assertOwnerHead(request, roles, actor.id);
      assertAssetRequestTransition(request.status, 'CLOSED_BY_OWNER');
      await this.setStatus(manager, request, 'CLOSED_BY_OWNER', actor.id);
      await this.event(manager, request.id, 'CLOSED_BY_OWNER', request.status, 'CLOSED_BY_OWNER', actor.id, reason.trim(), {});
      await this.notices.send(manager, request.id, 'CLOSED', ['REQUESTER', 'REVIEWERS'], { reason: reason.trim() });
    });
    return this.getById(id, actor);
  }

  // ---------- Solicitante ----------

  async correct(id: string, dto: CorrectAssetRequestDto, actor: AuthenticatedUser): Promise<AssetRequestDetailDto> {
    await this.dataSource.transaction(async (manager) => {
      const { request, roles } = await this.partyRequest(manager, id, actor.id, true);
      this.assertRequester(roles);
      if (request.status !== 'RETURNED') {
        throw new ApiException(ErrorCode.AssetRequestInvalidStateTransition, `La solicitud está ${request.status}: solo se corrige devuelta`);
      }
      const kind = dto.kind ?? request.kind;
      const requesting = dto.requestingCostCenterId ?? request.requesting_cost_center_id;
      const owner = dto.ownerCostCenterId ?? request.owner_cost_center_id;
      const startDate = kind === 'TEMPORARY' ? (dto.startDate ?? request.start_date) : null;
      const expectedReturnDate = kind === 'TEMPORARY' ? (dto.expectedReturnDate ?? request.expected_return_date) : null;
      this.assertDates(kind, startDate, expectedReturnDate);
      await this.assertCenters(manager, actor.id, request.requester_person_id, requesting, owner);
      const next = statusAfterCorrection({
        kind: kind !== request.kind,
        requestingCostCenter: requesting !== request.requesting_cost_center_id,
        ownerCostCenter: owner !== request.owner_cost_center_id,
      });
      assertAssetRequestTransition(request.status, next);
      const changed = [
        ...(kind !== request.kind ? ['kind'] : []),
        ...(requesting !== request.requesting_cost_center_id ? ['requestingCostCenterId'] : []),
        ...(owner !== request.owner_cost_center_id ? ['ownerCostCenterId'] : []),
        ...(dto.description !== undefined && dto.description.trim() !== request.description ? ['description'] : []),
        ...(dto.note !== undefined && (dto.note?.trim() || null) !== request.note ? ['note'] : []),
        ...(startDate !== request.start_date ? ['startDate'] : []),
        ...(expectedReturnDate !== request.expected_return_date ? ['expectedReturnDate'] : []),
      ];
      const discarded =
        next === 'REQUESTED'
          ? ((await manager.query('DELETE FROM asset_request_item WHERE request_id = $1 RETURNING asset_id', [request.id])) as [
              Array<{ asset_id: string }>,
              number,
            ])[0].map((row) => row.asset_id)
          : [];
      await manager.query(
        `UPDATE asset_request SET kind = $2, requesting_cost_center_id = $3, owner_cost_center_id = $4, description = $5, note = $6,
           start_date = $7, expected_return_date = $8, status = $9,
           accepted_by = CASE WHEN $9 = 'REQUESTED' THEN NULL ELSE accepted_by END,
           accepted_at = CASE WHEN $9 = 'REQUESTED' THEN NULL ELSE accepted_at END,
           expires_at = CASE WHEN $9 = 'ACCEPTED' THEN NOW() + make_interval(days => $10) ELSE NULL END,
           decided_by = $11, decided_at = NOW()
         WHERE id = $1`,
        [
          request.id,
          kind,
          requesting,
          owner,
          dto.description?.trim() ?? request.description,
          dto.note === undefined ? request.note : dto.note?.trim() || null,
          startDate,
          expectedReturnDate,
          next,
          ASSET_REQUEST_EXPIRY_DAYS,
          actor.id,
        ],
      );
      await this.event(manager, request.id, 'CORRECTED', request.status, next, actor.id, null, {
        changed,
        ...(discarded.length > 0 ? { discardedAssetIds: discarded } : {}),
      });
      await this.notices.send(manager, request.id, 'CORRECTED', next === 'REQUESTED' ? ['OWNER_HEADS'] : ['REVIEWERS'], {
        nextReviewer: next === 'REQUESTED' ? 'el centro dueño' : 'Control Interno',
      });
    });
    return this.getById(id, actor);
  }

  async cancel(id: string, reason: string, actor: AuthenticatedUser): Promise<AssetRequestDetailDto> {
    await this.dataSource.transaction(async (manager) => {
      const { request, roles } = await this.partyRequest(manager, id, actor.id, true);
      this.assertRequester(roles);
      assertAssetRequestTransition(request.status, 'CANCELLED');
      await this.setStatus(manager, request, 'CANCELLED', actor.id);
      await this.event(manager, request.id, 'CANCELLED', request.status, 'CANCELLED', actor.id, reason.trim(), {});
      const audience: AssetRequestAudience[] = request.status === 'RETURNED' ? ['OWNER_HEADS', 'REVIEWERS'] : ['OWNER_HEADS'];
      await this.notices.send(manager, request.id, 'CANCELLED', audience, { reason: reason.trim() });
    });
    return this.getById(id, actor);
  }

  // ---------- Control Interno ----------

  async returnToRequester(id: string, reason: string, actor: AuthenticatedUser): Promise<AssetRequestDetailDto> {
    await this.dataSource.transaction(async (manager) => {
      const { request, roles } = await this.partyRequest(manager, id, actor.id, true);
      this.assertReviewer(roles);
      assertAssetRequestTransition(request.status, 'RETURNED');
      // Los activos siguen reservados: si el solicitante solo corrige texto o fechas, vuelve a Control Interno con ellos.
      await manager.query(
        `UPDATE asset_request SET status = 'RETURNED', expires_at = NULL, decided_by = $2, decided_at = NOW() WHERE id = $1`,
        [request.id, actor.id],
      );
      await this.event(manager, request.id, 'RETURNED', request.status, 'RETURNED', actor.id, reason.trim(), {});
      await this.notices.send(manager, request.id, 'RETURNED', ['REQUESTER'], { reason: reason.trim() });
    });
    return this.getById(id, actor);
  }

  /**
   * Genera el documento en UNA transacción:
   * - TEMPORARY: el préstamo nace APPROVED (la aprobación es la aceptación del jefe dueño) con los activos aceptados y se
   *   entrega en el acto (LoansService.deliverWithin): activos ON_LOAN, préstamo PENDING_SIGNATURES y acta OCI-01-65
   *   encolada con ENTREGA = jefe dueño que aceptó, RECIBE = solicitante, AUDITA = Control Interno. Es el mismo paso que
   *   POST /loans/:id/deliver; hacerlo aquí evita un préstamo aprobado sin acta que nadie más atendería.
   * - PERMANENT: el traslado se crea con asset_request_id y los datos por activo del cuerpo, y su acta OCI-17-89 se
   *   encola (TransfersService.generateWithin) con ENTREGA = jefe dueño, RECIBE = solicitante, CONTROL_INTERNO y
   *   CONTABILIDAD por rol.
   * Las guardas de cada proceso se vuelven a aplicar; además todos los activos deben seguir en el centro dueño.
   */
  async generate(id: string, dto: GenerateAssetRequestDto, actor: AuthenticatedUser): Promise<AssetRequestDetailDto> {
    await this.dataSource.transaction(async (manager) => {
      const { request, roles } = await this.partyRequest(manager, id, actor.id, true);
      this.assertReviewer(roles);
      assertAssetRequestTransition(request.status, 'DOCUMENT_GENERATED');
      const { format } = await this.documents.formatReadiness(
        request.kind === 'TEMPORARY' ? LOAN_DELIVERY_FORMAT : TRANSFER_FORMAT_KEY,
        manager,
      );
      if (!(await this.permissions.userHasPermission(actor.id, format.generatePermission))) {
        throw new ApiException(ErrorCode.InsufficientPermissions, `Generar el ${format.key} requiere permiso ${format.generatePermission}`);
      }
      const assetIds = ((await manager.query(
        'SELECT asset_id FROM asset_request_item WHERE request_id = $1 AND open ORDER BY created_at, asset_id',
        [request.id],
      )) as Array<{ asset_id: string }>).map((row) => row.asset_id);
      if (assetIds.length === 0) {
        throw new ApiException(ErrorCode.InvalidState, 'La solicitud no tiene activos aceptados');
      }
      const [moved] = (await manager.query(
        'SELECT count(*)::int AS total FROM asset WHERE id = ANY($1) AND current_cost_center_id <> $2',
        [assetIds, request.owner_cost_center_id],
      )) as Array<{ total: number }>;
      if ((moved?.total ?? 0) > 0) {
        throw new ApiException(ErrorCode.AssetRequestAssetUnavailable, 'Algún activo aceptado ya no está en el centro dueño');
      }
      const ownerPerson = request.accepted_by ? await this.personOf(manager, request.accepted_by) : null;
      if (!ownerPerson) {
        throw new ApiException(ErrorCode.InvalidState, 'Quien aceptó la solicitud no tiene persona asociada: no puede firmar ENTREGA');
      }
      // Liberar la reserva antes de crear el documento: desde aquí los retiene el préstamo o el traslado.
      await manager.query('UPDATE asset_request_item SET open = FALSE WHERE request_id = $1', [request.id]);
      const justification = dto.justification?.trim() || request.description;
      let loanId: string | null = null;
      let transferId: string | null = null;
      if (request.kind === 'TEMPORARY') {
        loanId = await this.loans.createWithin(
          manager,
          {
            assetIds,
            targetCostCenterId: request.requesting_cost_center_id,
            targetLocationId: dto.targetLocationId ?? null,
            contactPersonId: request.requester_person_id,
            expectedReturnDate: request.expected_return_date ?? '',
            justification,
            deliveryNotes: null,
          },
          actor.id,
          {
            approved: {
              by: request.accepted_by ?? actor.id,
              at: request.accepted_at ?? new Date(),
              requestedBy: request.requester_user_id,
              assetRequestId: request.id,
            },
          },
        );
        const control = await this.signers.resolve('CONTROL', dto.controlSignerPersonId, manager);
        await this.loans.deliverWithin(
          manager,
          loanId,
          {
            deliveredByPersonId: ownerPerson,
            controlInternoPersonId: control,
            ...(dto.signerSubstitutions ? { signerSubstitutions: dto.signerSubstitutions } : {}),
            ...(dto.assetNotes ? { assetNotes: dto.assetNotes } : {}),
          },
          actor.id,
        );
      } else {
        const items = dto.items ?? [];
        const given = items.map((item) => item.assetId);
        if (given.length !== assetIds.length || assetIds.some((assetId) => !given.includes(assetId))) {
          throw new ApiException(ErrorCode.ValidationFailed, 'items debe traer exactamente los activos aceptados, uno por activo', [
            { field: 'items', message: `Se esperaban ${assetIds.length} activos aceptados` },
          ]);
        }
        transferId = await this.transfers.createWithin(
          manager,
          {
            items,
            targetCostCenterId: request.requesting_cost_center_id,
            requesterPersonId: ownerPerson,
            ownerPersonId: request.requester_person_id,
            justification,
          },
          actor.id,
          { assetRequestId: request.id },
        );
        await this.transfers.generateWithin(
          manager,
          transferId,
          {
            ...(dto.controlSignerPersonId ? { controlSignerPersonId: dto.controlSignerPersonId } : {}),
            ...(dto.accountingSignerPersonId ? { accountingSignerPersonId: dto.accountingSignerPersonId } : {}),
            ...(dto.signerSubstitutions ? { signerSubstitutions: dto.signerSubstitutions } : {}),
          },
          actor.id,
        );
      }
      await manager.query(
        `UPDATE asset_request SET status = 'DOCUMENT_GENERATED', loan_id = $2, transfer_id = $3, expires_at = NULL,
           decided_by = $4, decided_at = NOW() WHERE id = $1`,
        [request.id, loanId, transferId, actor.id],
      );
      await this.event(manager, request.id, 'DOCUMENT_GENERATED', request.status, 'DOCUMENT_GENERATED', actor.id, null, {
        ...(loanId ? { loanId } : {}),
        ...(transferId ? { transferId } : {}),
      });
      await this.notices.send(manager, request.id, 'GENERATED', ['REQUESTER', 'OWNER_HEADS'], {
        document: { kind: this.documentLabel(request.kind) },
      });
    });
    return this.getById(id, actor);
  }

  private documentLabel(kind: AssetRequestKind): string {
    return kind === 'TEMPORARY' ? `Préstamo de activos (${LOAN_DELIVERY_FORMAT})` : `Traslado de activos (${TRANSFER_FORMAT_KEY})`;
  }

  /**
   * El acta del préstamo o del traslado quedó firmada (observador del motor, misma transacción): avisa a ambos centros
   * con el enlace al acta. Idempotente por documento.
   */
  async onDocumentSigned(
    manager: EntityManager,
    link: { readonly column: 'loan_id' | 'transfer_id'; readonly entityId: string; readonly documentId: string; readonly number: string },
  ): Promise<void> {
    const [request] = (await manager.query(
      `SELECT id, kind, status FROM asset_request WHERE ${link.column} = $1`,
      [link.entityId],
    )) as Array<{ id: string; kind: AssetRequestKind; status: AssetRequestStatus }>;
    if (!request) {
      return;
    }
    const [already] = (await manager.query(
      `SELECT 1 FROM asset_request_event WHERE request_id = $1 AND event_type = 'DOCUMENT_COMPLETED' AND payload->>'documentId' = $2`,
      [request.id, link.documentId],
    )) as unknown[];
    if (already) {
      return;
    }
    await this.event(manager, request.id, 'DOCUMENT_COMPLETED', request.status, request.status, null, null, {
      documentId: link.documentId,
      number: link.number,
    });
    await this.notices.send(manager, request.id, 'COMPLETED', ['REQUESTER', 'OWNER_HEADS'], {
      document: { kind: this.documentLabel(request.kind), number: link.number, documentId: link.documentId },
    });
  }

  /**
   * Vencimiento: ACCEPTED con expires_at pasado → EXPIRED, activos liberados, aviso a solicitante, dueño y Control
   * Interno; cada solicitud en su transacción, con FOR UPDATE SKIP LOCKED (dos instancias no la vencen dos veces).
   */
  async expireDue(limit = 50): Promise<number> {
    let expired = 0;
    for (let index = 0; index < limit; index += 1) {
      const done = await this.dataSource.transaction(async (manager) => {
        const [row] = (await manager.query(
          `SELECT ${ROW_COLUMNS}, expires_at FROM asset_request
           WHERE status = 'ACCEPTED' AND expires_at <= NOW()
           ORDER BY expires_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
        )) as Array<AssetRequestRow & { expires_at: Date }>;
        if (!row) {
          return false;
        }
        await manager.query(`UPDATE asset_request SET status = 'EXPIRED', decided_by = NULL, decided_at = NOW() WHERE id = $1`, [row.id]);
        await manager.query('UPDATE asset_request_item SET open = FALSE WHERE request_id = $1', [row.id]);
        await this.event(manager, row.id, 'EXPIRED', 'ACCEPTED', 'EXPIRED', null, null, { expiresAt: row.expires_at });
        await this.notices.send(manager, row.id, 'EXPIRED', ['REQUESTER', 'OWNER_HEADS', 'REVIEWERS'], {
          expiredOn: longDate(new Date(row.expires_at)),
        });
        return true;
      });
      if (!done) {
        break;
      }
      expired += 1;
    }
    return expired;
  }

  // ---------- Activos del dueño ----------

  /** Solo el jefe dueño (y no el solicitante), con la solicitud REQUESTED; cualquier otro usuario: 404. */
  private async ownerOnly(manager: EntityManager, id: string, userId: string): Promise<AssetRequestRow> {
    const request = await this.row(manager, id, false);
    if (
      !request ||
      request.requester_user_id === userId ||
      !(await this.isHead(manager, userId, request.owner_cost_center_id))
    ) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'No existe la solicitud');
    }
    return request;
  }

  async eligibleAssets(id: string, query: EligibleAssetsQueryDto, actor: AuthenticatedUser): Promise<EligibleAssetDto[]> {
    const manager = this.dataSource.manager;
    const request = await this.ownerOnly(manager, id, actor.id);
    const q = query.q?.trim() ?? '';
    return (await manager.query(
      `SELECT a.id, ${ASSET_CODE} AS code, a.description, a.serial_number AS "serialNumber",
              a.operational_status AS "operationalStatus", a.physical_condition AS "physicalCondition", l.name AS "locationName"
       FROM asset a LEFT JOIN location l ON l.id = a.current_location_id
       WHERE a.current_cost_center_id = $1 AND cardinality(${BLOCKERS}) = 0
         AND ($4 = '' OR a.internal_code ILIKE '%' || $4 || '%' OR a.serial_number ILIKE '%' || $4 || '%'
              OR a.description ILIKE '%' || $4 || '%'
              OR EXISTS (SELECT 1 FROM asset_identifier i WHERE i.asset_id = a.id AND i.valid_to IS NULL AND i.value ILIKE '%' || $4 || '%'))
       ORDER BY code, a.id
       LIMIT $5`,
      [request.owner_cost_center_id, OPEN_LOAN_STATUSES, request.id, q, query.limit],
    )) as EligibleAssetDto[];
  }

  /** QR de la etiqueta: solo el jefe dueño y solo activos del centro dueño; cualquier otro caso 404 sin datos. */
  async resolveScan(id: string, token: string, actor: AuthenticatedUser): Promise<ResolvedScanDto> {
    const manager = this.dataSource.manager;
    const request = await this.ownerOnly(manager, id, actor.id);
    const assetId = await this.qr.assetIdFromToken(token);
    const [asset] = assetId
      ? ((await manager.query(
          `SELECT a.id, ${ASSET_CODE} AS code, a.description, a.serial_number AS "serialNumber",
                  a.operational_status AS "operationalStatus", a.physical_condition AS "physicalCondition",
                  l.name AS "locationName", ${BLOCKERS} AS blockers
           FROM asset a LEFT JOIN location l ON l.id = a.current_location_id
           WHERE a.id = $1 AND a.current_cost_center_id = $4`,
          [assetId, OPEN_LOAN_STATUSES, request.id, request.owner_cost_center_id],
        )) as Array<EligibleAssetDto & { blockers: string[] }>)
      : [];
    if (!asset) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'No existe el activo');
    }
    const { blockers, ...data } = asset;
    return { ...data, eligible: blockers.length === 0, reason: blockers.length > 0 ? `El activo ${blockers.join(', ')}` : null };
  }

  // ---------- Lectura ----------

  async list(query: QueryAssetRequestsDto, actor: AuthenticatedUser): Promise<AssetRequestListResponseDto> {
    let where: string;
    let scopeParam: unknown;
    if (query.box === 'review') {
      if (!(await this.isReviewer(actor.id))) {
        throw new ApiException(ErrorCode.InsufficientPermissions, `Requiere permiso ${ASSET_REQUEST_REVIEW}`);
      }
      where = '$1::uuid IS NULL';
      scopeParam = null;
    } else if (query.box === 'to-decide') {
      where = 'r.owner_cost_center_id = ANY($1::uuid[])';
      scopeParam = await this.headedCenters(actor.id);
    } else {
      where = 'r.requester_user_id = $1';
      scopeParam = actor.id;
    }
    const filter = `WHERE ${where} AND ($2::text IS NULL OR r.status = $2)`;
    const params = [scopeParam, query.status ?? null];
    const [count] = (await this.dataSource.query(`SELECT count(*)::int AS total FROM asset_request r ${filter}`, params)) as Array<{
      total: number;
    }>;
    const rows = (await this.dataSource.query(
      `${SUMMARY_SELECT} ${filter} ORDER BY r.created_at DESC, r.id DESC LIMIT $3 OFFSET $4`,
      [...params, query.pageSize, (query.page - 1) * query.pageSize],
    )) as Array<AssetRequestListResponseDto['items'][number]>;
    const total = count?.total ?? 0;
    return {
      items: rows.map((row) => ({
        ...row,
        expiresAt: iso(row.expiresAt),
        createdAt: iso(row.createdAt) ?? '',
        updatedAt: iso(row.updatedAt) ?? '',
      })),
      page: query.page,
      pageSize: query.pageSize,
      total,
      hasNext: query.page * query.pageSize < total,
    };
  }

  async getById(id: string, actor: AuthenticatedUser): Promise<AssetRequestDetailDto> {
    const { roles } = await this.partyRequest(this.dataSource.manager, id, actor.id);
    return this.detail(id, roles);
  }

  private async detail(id: string, viewerRoles: AssetRequestViewerRole[]): Promise<AssetRequestDetailDto> {
    const manager = this.dataSource.manager;
    const [row] = (await manager.query(
      `${SUMMARY_SELECT.replace(
        'FROM asset_request r',
        `, r.note, to_char(r.start_date, 'YYYY-MM-DD') AS "startDate",
           to_char(r.expected_return_date, 'YYYY-MM-DD') AS "expectedReturnDate",
           ${USER_JSON('au', 'ap')} AS "acceptedBy", r.accepted_at AS "acceptedAt",
           ${USER_JSON('du', 'dp')} AS "decidedBy", r.decided_at AS "decidedAt", r.loan_id, r.transfer_id
         FROM asset_request r`,
      )}
       LEFT JOIN app_user au ON au.id = r.accepted_by LEFT JOIN person ap ON ap.id = au.person_id
       LEFT JOIN app_user du ON du.id = r.decided_by LEFT JOIN person dp ON dp.id = du.person_id
       WHERE r.id = $1`,
      [id],
    )) as Array<Record<string, unknown>>;
    if (!row) {
      throw new ApiException(ErrorCode.ResourceNotFound, 'No existe la solicitud');
    }
    const items = (await manager.query(
      `SELECT a.id AS "assetId", ${ASSET_CODE} AS code, a.description, a.operational_status AS "operationalStatus", i.open
       FROM asset_request_item i JOIN asset a ON a.id = i.asset_id WHERE i.request_id = $1 ORDER BY code, a.id`,
      [id],
    )) as AssetRequestDetailDto['items'];
    const events = (await manager.query(
      `SELECT e.id, e.event_type AS "eventType", e.from_status AS "fromStatus", e.to_status AS "toStatus",
              ${USER_JSON('u', 'p')} AS actor, e.reason, e.payload, e.created_at AS "createdAt"
       FROM asset_request_event e LEFT JOIN app_user u ON u.id = e.actor_user_id LEFT JOIN person p ON p.id = u.person_id
       WHERE e.request_id = $1 ORDER BY e.created_at, e.id`,
      [id],
    )) as Array<AssetRequestDetailDto['events'][number]>;
    const loanId = row['loan_id'] as string | null;
    const transferId = row['transfer_id'] as string | null;
    const [document] = loanId
      ? ((await manager.query(
          `SELECT 'LOAN' AS kind, l.id, l.status, d.id AS "documentId", d.number AS "documentNumber", d.status AS "documentStatus"
           FROM asset_loan l LEFT JOIN document d ON d.id = l.delivery_document_id WHERE l.id = $1`,
          [loanId],
        )) as Array<AssetRequestDetailDto['document']>)
      : transferId
        ? ((await manager.query(
            `SELECT 'TRANSFER' AS kind, t.id, t.status, d.id AS "documentId", d.number AS "documentNumber", d.status AS "documentStatus"
             FROM asset_transfer t LEFT JOIN document d ON d.id = t.document_id WHERE t.id = $1`,
            [transferId],
          )) as Array<AssetRequestDetailDto['document']>)
        : [];
    const { loan_id: _loan, transfer_id: _transfer, ...rest } = row;
    return {
      ...(rest as unknown as AssetRequestDetailDto),
      expiresAt: iso(row['expiresAt'] as Date | null),
      createdAt: iso(row['createdAt'] as Date) ?? '',
      updatedAt: iso(row['updatedAt'] as Date) ?? '',
      acceptedAt: iso(row['acceptedAt'] as Date | null),
      decidedAt: iso(row['decidedAt'] as Date | null),
      document: document ?? null,
      items,
      events: events.map((event) => ({ ...event, createdAt: iso(event.createdAt) ?? '' })),
      viewerRoles,
    };
  }

  // ---------- Apoyo ----------

  private async setStatus(manager: EntityManager, request: AssetRequestRow, status: AssetRequestStatus, actorId: string): Promise<void> {
    await manager.query(
      `UPDATE asset_request SET status = $2, expires_at = NULL, decided_by = $3, decided_at = NOW() WHERE id = $1`,
      [request.id, status, actorId],
    );
    await manager.query('UPDATE asset_request_item SET open = FALSE WHERE request_id = $1', [request.id]);
  }

  private async event(
    manager: EntityManager,
    requestId: string,
    eventType: string,
    from: AssetRequestStatus | null,
    to: AssetRequestStatus | null,
    actorId: string | null,
    reason: string | null,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO asset_request_event (request_id, event_type, from_status, to_status, actor_user_id, reason, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [requestId, eventType, from, to, actorId, reason, JSON.stringify(payload)],
    );
  }
}
