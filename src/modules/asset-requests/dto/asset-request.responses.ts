import { ApiProperty } from '@nestjs/swagger';
import { OPERATIONAL_STATUSES, type OperationalStatus } from '../../assets/enums/operational-status.enum.js';
import { PHYSICAL_CONDITIONS, type PhysicalCondition } from '../../assets/enums/physical-condition.enum.js';
import {
  ASSET_REQUEST_KINDS,
  ASSET_REQUEST_STATUSES,
  type AssetRequestKind,
  type AssetRequestStatus,
} from '../domain/asset-request.js';

export const ASSET_REQUEST_VIEWER_ROLES = ['REQUESTER', 'OWNER_HEAD', 'REVIEWER', 'READER'] as const;
export type AssetRequestViewerRole = (typeof ASSET_REQUEST_VIEWER_ROLES)[number];

export const ASSET_REQUEST_DOCUMENT_KINDS = ['LOAN', 'TRANSFER'] as const;

export class AssetRequestCostCenterDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ description: 'Código externo del centro de costo' })
  readonly code!: string;

  @ApiProperty()
  readonly name!: string;
}

/** Centros para armar o corregir una solicitud: solo id, código y nombre (sin jefes, conteos ni activos). */
export class AssetRequestCentersDto {
  @ApiProperty({
    type: [AssetRequestCostCenterDto],
    description:
      'Centros activos de los que el usuario es jefe vigente hoy: desde ellos puede solicitar (requestingCostCenterId). Vacío si no dirige ninguno',
  })
  readonly headed!: AssetRequestCostCenterDto[];

  @ApiProperty({
    type: [AssetRequestCostCenterDto],
    description:
      'Centros activos que aceptan activos, a los que se les puede pedir (ownerCostCenterId). Si tiene jefe vigente que decida lo dice GET /asset-requests/owner-availability',
  })
  readonly owners!: AssetRequestCostCenterDto[];
}

export class AssetRequestUserDto {
  @ApiProperty({ format: 'uuid' })
  readonly userId!: string;

  @ApiProperty({ type: 'string', nullable: true })
  readonly name!: string | null;
}

export class AssetRequestSummaryDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ example: 'SOL-2026-0007' })
  readonly code!: string;

  @ApiProperty({ enum: ASSET_REQUEST_KINDS, enumName: 'AssetRequestKind' })
  readonly kind!: AssetRequestKind;

  @ApiProperty({ enum: ASSET_REQUEST_STATUSES, enumName: 'AssetRequestStatus' })
  readonly status!: AssetRequestStatus;

  @ApiProperty({ type: () => AssetRequestCostCenterDto, description: 'Centro que solicita (destino)' })
  readonly requestingCostCenter!: AssetRequestCostCenterDto;

  @ApiProperty({ type: () => AssetRequestCostCenterDto, description: 'Centro dueño de los activos' })
  readonly ownerCostCenter!: AssetRequestCostCenterDto;

  @ApiProperty({ type: () => AssetRequestUserDto })
  readonly requester!: AssetRequestUserDto;

  @ApiProperty()
  readonly description!: string;

  @ApiProperty({ type: 'integer', description: 'Activos elegidos por el dueño (0 hasta que acepta)' })
  readonly assetCount!: number;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true, description: 'Vencimiento si está ACCEPTED' })
  readonly expiresAt!: string | null;

  @ApiProperty({ type: 'string', format: 'date-time' })
  readonly createdAt!: string;

  @ApiProperty({ type: 'string', format: 'date-time' })
  readonly updatedAt!: string;
}

export class AssetRequestListResponseDto {
  @ApiProperty({ type: [AssetRequestSummaryDto] })
  readonly items!: AssetRequestSummaryDto[];

  @ApiProperty({ type: 'integer' })
  readonly page!: number;

  @ApiProperty({ type: 'integer' })
  readonly pageSize!: number;

  @ApiProperty({ type: 'integer' })
  readonly total!: number;

  @ApiProperty()
  readonly hasNext!: boolean;
}

export class AssetRequestItemDto {
  @ApiProperty({ format: 'uuid' })
  readonly assetId!: string;

  @ApiProperty({ description: 'Código visible, código heredado o código interno, en ese orden' })
  readonly code!: string;

  @ApiProperty()
  readonly description!: string;

  @ApiProperty({ enum: OPERATIONAL_STATUSES, enumName: 'AssetOperationalStatus' })
  readonly operationalStatus!: OperationalStatus;

  @ApiProperty({ description: 'El activo sigue reservado por esta solicitud' })
  readonly open!: boolean;
}

export class AssetRequestEventDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({
    description:
      'CREATED, ACCEPTED, CLOSED_BY_OWNER, RETURNED, CORRECTED, CANCELLED, LOAN_SCHEDULED (préstamo generado, sin entregar), ' +
      'LOAN_START_NOTICE (aviso del día de inicio), LOAN_DELIVERED (préstamo entregado: acta encolada), DOCUMENT_GENERATED, ' +
      'LOAN_REJECTED (el préstamo programado se rechazó antes de entregarse: reason = motivo del rechazo, payload.loanId; la solicitud queda CLOSED_LOAN_REJECTED), ' +
      'EXPIRED (payload.expiredFrom = RETURNED y returnReason si venció devuelta), DOCUMENT_COMPLETED',
  })
  readonly eventType!: string;

  @ApiProperty({ enum: ASSET_REQUEST_STATUSES, enumName: 'AssetRequestStatus', nullable: true })
  readonly fromStatus!: AssetRequestStatus | null;

  @ApiProperty({ enum: ASSET_REQUEST_STATUSES, enumName: 'AssetRequestStatus', nullable: true })
  readonly toStatus!: AssetRequestStatus | null;

  @ApiProperty({ type: () => AssetRequestUserDto, nullable: true, description: 'null = el sistema (vencimiento)' })
  readonly actor!: AssetRequestUserDto | null;

  @ApiProperty({ type: 'string', nullable: true, description: 'Motivo o comentario' })
  readonly reason!: string | null;

  @ApiProperty({ type: 'object', additionalProperties: true })
  readonly payload!: Record<string, unknown>;

  @ApiProperty({ type: 'string', format: 'date-time' })
  readonly createdAt!: string;
}

export class AssetRequestDocumentDto {
  @ApiProperty({ enum: ASSET_REQUEST_DOCUMENT_KINDS, enumName: 'AssetRequestDocumentKind' })
  readonly kind!: (typeof ASSET_REQUEST_DOCUMENT_KINDS)[number];

  @ApiProperty({ format: 'uuid', description: 'Id del préstamo (LOAN) o del traslado (TRANSFER)' })
  readonly id!: string;

  @ApiProperty({ description: 'Estado del préstamo o del traslado' })
  readonly status!: string;

  @ApiProperty({
    type: 'string',
    format: 'date',
    nullable: true,
    description: 'LOAN: desde cuándo se puede entregar (POST /loans/:id/deliver). TRANSFER: null',
  })
  readonly startDate!: string | null;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, description: 'Acta (OCI-01-65 u OCI-17-89) cuando ya se generó' })
  readonly documentId!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  readonly documentNumber!: string | null;

  @ApiProperty({ type: 'string', nullable: true, description: 'PENDING_SIGNATURE, SIGNED, REJECTED, VOIDED' })
  readonly documentStatus!: string | null;
}

export class AssetRequestDetailDto extends AssetRequestSummaryDto {
  @ApiProperty({ type: 'string', nullable: true })
  readonly note!: string | null;

  @ApiProperty({ type: 'string', format: 'date', nullable: true })
  readonly startDate!: string | null;

  @ApiProperty({ type: 'string', format: 'date', nullable: true })
  readonly expectedReturnDate!: string | null;

  @ApiProperty({ type: () => AssetRequestUserDto, nullable: true })
  readonly acceptedBy!: AssetRequestUserDto | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly acceptedAt!: string | null;

  @ApiProperty({ type: () => AssetRequestUserDto, nullable: true, description: 'Última decisión que cambió el estado' })
  readonly decidedBy!: AssetRequestUserDto | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly decidedAt!: string | null;

  @ApiProperty({ type: () => AssetRequestDocumentDto, nullable: true })
  readonly document!: AssetRequestDocumentDto | null;

  @ApiProperty({ type: [AssetRequestItemDto] })
  readonly items!: AssetRequestItemDto[];

  @ApiProperty({ type: [AssetRequestEventDto] })
  readonly events!: AssetRequestEventDto[];

  @ApiProperty({
    enum: ASSET_REQUEST_VIEWER_ROLES,
    enumName: 'AssetRequestViewerRole',
    isArray: true,
    description:
      'Papel de quien consulta: decide qué acciones muestra la pantalla. READER (asset_request:read:global) solo lee: ninguna acción',
  })
  readonly viewerRoles!: AssetRequestViewerRole[];
}

export class OwnerAvailabilityDto {
  @ApiProperty({ description: 'El centro tiene al menos un jefe vigente que puede decidir la solicitud' })
  readonly hasHead!: boolean;

  @ApiProperty()
  readonly message!: string;
}

export class EligibleAssetDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ description: 'Código visible, código heredado o código interno, en ese orden' })
  readonly code!: string;

  @ApiProperty()
  readonly description!: string;

  @ApiProperty({ type: 'string', nullable: true })
  readonly serialNumber!: string | null;

  @ApiProperty({ enum: OPERATIONAL_STATUSES, enumName: 'AssetOperationalStatus' })
  readonly operationalStatus!: OperationalStatus;

  @ApiProperty({ enum: PHYSICAL_CONDITIONS, enumName: 'PhysicalCondition' })
  readonly physicalCondition!: PhysicalCondition;

  @ApiProperty({ type: 'string', nullable: true })
  readonly locationName!: string | null;
}

export class ResolvedScanDto extends EligibleAssetDto {
  @ApiProperty({ description: 'Se puede elegir: prestable y sin préstamo, traslado, toma ni otra solicitud abiertos' })
  readonly eligible!: boolean;

  @ApiProperty({ type: 'string', nullable: true, description: 'Por qué no se puede elegir' })
  readonly reason!: string | null;
}

export const ASSET_REQUEST_RESPONSE_MODELS = [
  AssetRequestCostCenterDto,
  AssetRequestCentersDto,
  AssetRequestUserDto,
  AssetRequestSummaryDto,
  AssetRequestListResponseDto,
  AssetRequestItemDto,
  AssetRequestEventDto,
  AssetRequestDocumentDto,
  AssetRequestDetailDto,
  OwnerAvailabilityDto,
  EligibleAssetDto,
  ResolvedScanDto,
];
