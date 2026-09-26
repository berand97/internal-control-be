import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { OPERATIONAL_STATUSES, OperationalStatus } from '../../assets/enums/operational-status.enum.js';
import { DOCUMENT_STATUSES, SIGNATURE_STATUSES } from '../../documents/dto/document.responses.js';
import { HANDOVER_STATUSES, type HandoverStatus } from '../domain/handover.js';

export const DOCUMENT_GENERATION_STATUSES = ['NONE', 'PENDING', 'FAILED', 'GENERATED', 'CANCELLED'] as const;

/** Tope técnico de activos por acta (tamaño del documento); no es una regla de negocio. */
export const MAX_HANDOVER_ASSETS = 500;

// ---------- Entrada ----------

export class CreateHandoverAssetDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  readonly assetId!: string;

  @ApiPropertyOptional({ description: 'Observación del activo en el acta', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  readonly note?: string;
}

export class CreateHandoverDto {
  @ApiProperty({ type: [CreateHandoverAssetDto], description: `Activos a entregar, en el orden del acta (1 a ${MAX_HANDOVER_ASSETS})` })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_HANDOVER_ASSETS)
  @ValidateNested({ each: true })
  @Type(() => CreateHandoverAssetDto)
  readonly assets!: CreateHandoverAssetDto[];

  @ApiProperty({ format: 'uuid', description: 'Persona que recibe: firma el turno RECIBE y queda como responsable al firmarse el acta' })
  @IsUUID('all')
  readonly receiverPersonId!: string;

  @ApiProperty({ format: 'uuid', description: 'Centro de costo del acta; debe ser el centro actual de cada activo' })
  @IsUUID('all')
  readonly costCenterId!: string;

  @ApiProperty({ format: 'uuid', description: 'Persona de Control Interno que firma el turno AUDITA' })
  @IsUUID('all')
  readonly auditorPersonId!: string;
}

export class CancelHandoverDto {
  @ApiProperty({ description: 'Motivo: queda en la entrega y en el acta anulada', minLength: 5, maxLength: 500 })
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  readonly reason!: string;
}

export class QueryHandoversDto {
  @ApiPropertyOptional({ type: 'integer', minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  readonly page: number = 1;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  readonly pageSize: number = 20;

  @ApiPropertyOptional({ enum: HANDOVER_STATUSES, enumName: 'HandoverStatus' })
  @IsOptional()
  @IsIn(HANDOVER_STATUSES)
  readonly status?: HandoverStatus;
}

// ---------- Salida ----------

export class HandoverPersonDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty()
  readonly name!: string;

  @ApiProperty({ type: 'string', nullable: true })
  readonly documentNumber!: string | null;
}

export class HandoverCostCenterDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ description: 'Código externo del centro de costo' })
  readonly code!: string;

  @ApiProperty()
  readonly name!: string;
}

export class HandoverCreatorDto {
  @ApiProperty({ format: 'uuid' })
  readonly userId!: string;

  @ApiProperty({ type: 'string', nullable: true })
  readonly name!: string | null;
}

export class HandoverAssetDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ description: 'Código visible, código heredado o código interno, en ese orden' })
  readonly code!: string;

  @ApiProperty()
  readonly description!: string;

  @ApiProperty({ enum: OPERATIONAL_STATUSES, enumName: 'AssetOperationalStatus' })
  readonly operationalStatus!: OperationalStatus;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, description: 'Responsable actual del activo' })
  readonly responsibleId!: string | null;
}

export class HandoverItemDto {
  @ApiProperty({ type: 'integer', description: 'Posición en el acta, desde 1' })
  readonly lineNumber!: number;

  @ApiProperty({ type: () => HandoverAssetDto })
  readonly asset!: HandoverAssetDto;

  @ApiProperty({ type: 'string', nullable: true, description: 'Observación del activo en el acta' })
  readonly note!: string | null;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, description: 'Movimiento ASSIGNMENT que aplicó el acta; null hasta que se firma' })
  readonly movementId!: string | null;
}

export class HandoverSignatureDto {
  @ApiProperty({ type: 'integer' })
  readonly order!: number;

  @ApiProperty({ example: 'RECIBE' })
  readonly role!: string;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true })
  readonly personId!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  readonly name!: string | null;

  @ApiProperty({ enum: SIGNATURE_STATUSES, enumName: 'DocumentSignatureStatus' })
  readonly status!: (typeof SIGNATURE_STATUSES)[number];

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly signedAt!: string | null;
}

export class HandoverDocumentDto {
  @ApiProperty({
    enum: DOCUMENT_GENERATION_STATUSES,
    enumName: 'DocumentGenerationStatus',
    description: 'Generación del acta (outbox): PENDING en cola, FAILED con lastError, GENERATED con documentId',
  })
  readonly generation!: (typeof DOCUMENT_GENERATION_STATUSES)[number];

  @ApiProperty({ format: 'uuid', description: 'Solicitud del outbox; se reintenta con POST /documents/requests/:requestId/retry' })
  readonly requestId!: string;

  @ApiProperty({ type: 'integer', description: 'Intentos de generación' })
  readonly attempts!: number;

  @ApiProperty({ type: 'string', nullable: true, description: 'Último error de generación; solo con generation FAILED' })
  readonly lastError!: string | null;

  @ApiProperty({ description: 'FAILED y el job todavía la reintenta solo (menos de 5 intentos)' })
  readonly retriesAutomatically!: boolean;

  @ApiProperty({ description: 'FAILED: se puede reencolar con POST /documents/requests/:requestId/retry' })
  readonly retryable!: boolean;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, description: 'Acta generada; detalle y firma en /documents/:id' })
  readonly documentId!: string | null;

  @ApiProperty({ type: 'string', nullable: true, example: '0093' })
  readonly number!: string | null;

  @ApiProperty({ enum: DOCUMENT_STATUSES, enumName: 'DocumentStatus', nullable: true })
  readonly status!: (typeof DOCUMENT_STATUSES)[number] | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly signedAt!: string | null;

  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'El acta tiene todas sus firmas (o un rechazo) pero aplicar la entrega falló; se reintenta con el sync del acta',
  })
  readonly lifecycleError!: string | null;

  @ApiProperty({ type: [HandoverSignatureDto], description: 'Firmantes finales en orden de firma; vacío sin acta' })
  readonly signatures!: HandoverSignatureDto[];
}

export class HandoverDetailDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ enum: HANDOVER_STATUSES, enumName: 'HandoverStatus' })
  readonly status!: HandoverStatus;

  @ApiProperty({ type: () => HandoverCostCenterDto })
  readonly costCenter!: HandoverCostCenterDto;

  @ApiProperty({ type: () => HandoverPersonDto, description: 'Quién recibe según la solicitud' })
  readonly receiver!: HandoverPersonDto;

  @ApiProperty({ type: () => HandoverPersonDto, description: 'Quién firma por Control Interno según la solicitud' })
  readonly auditor!: HandoverPersonDto;

  @ApiProperty({
    type: () => HandoverPersonDto,
    nullable: true,
    description: 'Responsable asignado: el firmante RECIBE final (puede diferir de receiver si el turno se reasignó). null hasta SIGNED',
  })
  readonly assignedPerson!: HandoverPersonDto | null;

  @ApiProperty({ type: () => HandoverCreatorDto })
  readonly createdBy!: HandoverCreatorDto;

  @ApiProperty({ type: 'string', format: 'date-time' })
  readonly createdAt!: string;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true, description: 'Cuándo quedó SIGNED, REJECTED o CANCELLED' })
  readonly closedAt!: string | null;

  @ApiProperty({ type: () => HandoverCreatorDto, nullable: true, description: 'Quién canceló la entrega; null si no está CANCELLED' })
  readonly cancelledBy!: HandoverCreatorDto | null;

  @ApiProperty({ type: 'string', nullable: true, description: 'Motivo de la cancelación; null si no está CANCELLED' })
  readonly cancelReason!: string | null;

  @ApiProperty({ type: [HandoverItemDto] })
  readonly items!: HandoverItemDto[];

  @ApiProperty({ type: () => HandoverDocumentDto })
  readonly document!: HandoverDocumentDto;
}

export class HandoverListItemDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ enum: HANDOVER_STATUSES, enumName: 'HandoverStatus' })
  readonly status!: HandoverStatus;

  @ApiProperty({ type: () => HandoverCostCenterDto })
  readonly costCenter!: HandoverCostCenterDto;

  @ApiProperty({ type: () => HandoverPersonDto })
  readonly receiver!: HandoverPersonDto;

  @ApiProperty({ type: () => HandoverPersonDto, nullable: true })
  readonly assignedPerson!: HandoverPersonDto | null;

  @ApiProperty({ type: 'integer' })
  readonly assetCount!: number;

  @ApiProperty({ enum: DOCUMENT_GENERATION_STATUSES, enumName: 'DocumentGenerationStatus' })
  readonly generation!: (typeof DOCUMENT_GENERATION_STATUSES)[number];

  @ApiProperty({ type: 'string', nullable: true, description: 'Último error de generación; solo con generation FAILED' })
  readonly generationError!: string | null;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true })
  readonly documentId!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  readonly documentNumber!: string | null;

  @ApiProperty({ type: 'string', format: 'date-time' })
  readonly createdAt!: string;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly closedAt!: string | null;
}

export class HandoverListResponseDto {
  @ApiProperty({ type: [HandoverListItemDto] })
  readonly items!: HandoverListItemDto[];

  @ApiProperty({ type: 'integer' })
  readonly page!: number;

  @ApiProperty({ type: 'integer' })
  readonly pageSize!: number;

  @ApiProperty({ type: 'integer' })
  readonly total!: number;

  @ApiProperty()
  readonly hasNext!: boolean;
}
