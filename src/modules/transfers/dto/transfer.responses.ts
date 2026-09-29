import { ApiProperty } from '@nestjs/swagger';
import { OPERATIONAL_STATUSES, type OperationalStatus } from '../../assets/enums/operational-status.enum.js';
import { PHYSICAL_CONDITIONS, type PhysicalCondition } from '../../assets/enums/physical-condition.enum.js';
import { DOCUMENT_STATUSES, SIGNATURE_STATUSES } from '../../documents/dto/document.responses.js';
import { TRANSFER_STATUSES, type TransferStatus } from '../domain/transfer.js';

export const TRANSFER_DOCUMENT_GENERATIONS = ['NONE', 'PENDING', 'FAILED', 'GENERATED', 'CANCELLED'] as const;
export const TRANSFER_WARNING_CODES = ['NO_CONTROL_SIGNER', 'NO_ACCOUNTING_SIGNER'] as const;
export type TransferWarningCode = (typeof TRANSFER_WARNING_CODES)[number];

export class TransferPersonDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty()
  readonly name!: string;

  @ApiProperty({ type: 'string', nullable: true })
  readonly documentNumber!: string | null;
}

export class TransferCostCenterDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ description: 'Código externo del centro de costo' })
  readonly code!: string;

  @ApiProperty()
  readonly name!: string;
}

export class TransferUserDto {
  @ApiProperty({ format: 'uuid' })
  readonly userId!: string;

  @ApiProperty({ type: 'string', nullable: true })
  readonly name!: string | null;
}

export class TransferReasonRefDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty()
  readonly code!: string;

  @ApiProperty()
  readonly name!: string;
}

export class TransferItemAssetDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ description: 'Código visible, código heredado o código interno, en ese orden' })
  readonly code!: string;

  @ApiProperty()
  readonly description!: string;

  @ApiProperty({ format: 'uuid', description: 'Centro de costo actual del activo' })
  readonly costCenterId!: string;

  @ApiProperty({ enum: OPERATIONAL_STATUSES, enumName: 'AssetOperationalStatus' })
  readonly operationalStatus!: OperationalStatus;
}

export class TransferItemDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ type: 'integer', description: 'Posición en el acta, desde 1' })
  readonly lineNumber!: number;

  @ApiProperty({ type: () => TransferItemAssetDto })
  readonly asset!: TransferItemAssetDto;

  @ApiProperty({ enum: PHYSICAL_CONDITIONS, enumName: 'PhysicalCondition', description: 'Estado del activo en el acta' })
  readonly physicalCondition!: PhysicalCondition;

  @ApiProperty({ description: 'Verificación física (columna «Físico»)' })
  readonly physicallyVerified!: boolean;

  @ApiProperty({ type: 'string', nullable: true })
  readonly verificationNote!: string | null;

  @ApiProperty({ description: 'Tiene numeración/placa (columna «Numeración»)' })
  readonly numberingPresent!: boolean;

  @ApiProperty({ type: () => TransferReasonRefDto })
  readonly reason!: TransferReasonRefDto;

  @ApiProperty({ type: 'string', nullable: true })
  readonly observations!: string | null;

  @ApiProperty({
    type: 'string',
    format: 'uuid',
    nullable: true,
    description: 'Movimiento TRANSFER que aplicó el acta firmada; null hasta COMPLETED',
  })
  readonly movementId!: string | null;
}

export class TransferSignatureDto {
  @ApiProperty({ type: 'integer' })
  readonly order!: number;

  @ApiProperty({ example: 'ENTREGA' })
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

export class TransferDocumentDto {
  @ApiProperty({
    enum: TRANSFER_DOCUMENT_GENERATIONS,
    enumName: 'DocumentGenerationStatus',
    description:
      'NONE: todavía no se genera (DRAFT). PENDING en cola, FAILED con lastError, GENERATED con documentId, CANCELLED si se canceló la solicitud',
  })
  readonly generation!: (typeof TRANSFER_DOCUMENT_GENERATIONS)[number];

  @ApiProperty({
    type: 'string',
    format: 'uuid',
    nullable: true,
    description: 'Solicitud del outbox; null en DRAFT. Se reintenta con POST /documents/requests/:requestId/retry',
  })
  readonly requestId!: string | null;

  @ApiProperty({ type: 'integer', description: 'Intentos de generación' })
  readonly attempts!: number;

  @ApiProperty({ type: 'string', nullable: true, description: 'Último error de generación; solo con generation FAILED' })
  readonly lastError!: string | null;

  @ApiProperty({ description: 'FAILED y el job todavía la reintenta solo (menos de 5 intentos)' })
  readonly retriesAutomatically!: boolean;

  @ApiProperty({ description: 'FAILED: se puede reencolar con POST /documents/requests/:requestId/retry' })
  readonly retryable!: boolean;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, description: 'Acta generada; detalle, firma y descarga en /documents/:id' })
  readonly documentId!: string | null;

  @ApiProperty({ type: 'string', nullable: true, example: '00144' })
  readonly number!: string | null;

  @ApiProperty({ enum: DOCUMENT_STATUSES, enumName: 'DocumentStatus', nullable: true })
  readonly status!: (typeof DOCUMENT_STATUSES)[number] | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly signedAt!: string | null;

  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'El acta tiene todas sus firmas (o un rechazo) pero aplicar el traslado falló; se reintenta con el sync del acta',
  })
  readonly lifecycleError!: string | null;

  @ApiProperty({ type: [TransferSignatureDto], description: 'Firmantes finales en orden de firma; vacío sin acta' })
  readonly signatures!: TransferSignatureDto[];
}

export class TransferWarningDto {
  @ApiProperty({ enum: TRANSFER_WARNING_CODES, enumName: 'TransferWarningCode' })
  readonly code!: TransferWarningCode;

  @ApiProperty()
  readonly message!: string;
}

export class TransferDetailDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ enum: TRANSFER_STATUSES, enumName: 'TransferStatus' })
  readonly status!: TransferStatus;

  @ApiProperty({ type: () => TransferCostCenterDto, description: 'Centro que entrega' })
  readonly sourceCostCenter!: TransferCostCenterDto;

  @ApiProperty({ type: () => TransferCostCenterDto, description: 'Centro que recibe' })
  readonly targetCostCenter!: TransferCostCenterDto;

  @ApiProperty({ type: () => TransferPersonDto, description: 'Quien entrega: turno ENTREGA' })
  readonly requester!: TransferPersonDto;

  @ApiProperty({ type: () => TransferPersonDto, description: 'Quien recibe: turno RECIBE' })
  readonly owner!: TransferPersonDto;

  @ApiProperty({ type: () => TransferPersonDto, nullable: true, description: 'Turno CONTROL_INTERNO designado al generar; null en DRAFT' })
  readonly controlSigner!: TransferPersonDto | null;

  @ApiProperty({ type: () => TransferPersonDto, nullable: true, description: 'Turno CONTABILIDAD designado al generar; null en DRAFT' })
  readonly accountingSigner!: TransferPersonDto | null;

  @ApiProperty()
  readonly justification!: string;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, description: 'Solicitud de activos de origen (si el traslado nació de una)' })
  readonly assetRequestId!: string | null;

  @ApiProperty({ type: () => TransferUserDto })
  readonly createdBy!: TransferUserDto;

  @ApiProperty({ type: 'string', format: 'date-time' })
  readonly createdAt!: string;

  @ApiProperty({ type: () => TransferUserDto, nullable: true })
  readonly generatedBy!: TransferUserDto | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly generatedAt!: string | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly completedAt!: string | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly rejectedAt!: string | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly cancelledAt!: string | null;

  @ApiProperty({ type: () => TransferUserDto, nullable: true })
  readonly cancelledBy!: TransferUserDto | null;

  @ApiProperty({ type: 'string', nullable: true })
  readonly cancelReason!: string | null;

  @ApiProperty({ type: [TransferItemDto] })
  readonly items!: TransferItemDto[];

  @ApiProperty({ type: () => TransferDocumentDto })
  readonly document!: TransferDocumentDto;

  @ApiProperty({
    description:
      'Hay al menos un usuario activo con act:sign_control:global vigente (Firmar actas por Control Interno)',
  })
  readonly controlSignerAvailable!: boolean;

  @ApiProperty({ description: 'Hay al menos un usuario activo con el permiso `transfer:sign_accounting:global` vigente' })
  readonly accountingSignerAvailable!: boolean;

  @ApiProperty({
    type: [TransferWarningDto],
    description: 'Avisos para la pantalla antes de generar: sin firmante posible de Control Interno o de Contabilidad el acta no se puede generar',
  })
  readonly warnings!: TransferWarningDto[];
}

export class TransferListItemDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ enum: TRANSFER_STATUSES, enumName: 'TransferStatus' })
  readonly status!: TransferStatus;

  @ApiProperty({ type: () => TransferCostCenterDto })
  readonly sourceCostCenter!: TransferCostCenterDto;

  @ApiProperty({ type: () => TransferCostCenterDto })
  readonly targetCostCenter!: TransferCostCenterDto;

  @ApiProperty({ type: () => TransferPersonDto })
  readonly owner!: TransferPersonDto;

  @ApiProperty({ type: 'integer' })
  readonly assetCount!: number;

  @ApiProperty({ enum: TRANSFER_DOCUMENT_GENERATIONS, enumName: 'DocumentGenerationStatus' })
  readonly generation!: (typeof TRANSFER_DOCUMENT_GENERATIONS)[number];

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true })
  readonly documentId!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  readonly documentNumber!: string | null;

  @ApiProperty({ type: 'string', format: 'date-time' })
  readonly createdAt!: string;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly completedAt!: string | null;
}

export class TransferListResponseDto {
  @ApiProperty({ type: [TransferListItemDto] })
  readonly items!: TransferListItemDto[];

  @ApiProperty({ type: 'integer' })
  readonly page!: number;

  @ApiProperty({ type: 'integer' })
  readonly pageSize!: number;

  @ApiProperty({ type: 'integer' })
  readonly total!: number;

  @ApiProperty()
  readonly hasNext!: boolean;
}

export class TransferSignerCandidateDto {
  @ApiProperty({ format: 'uuid' })
  readonly personId!: string;

  @ApiProperty()
  readonly name!: string;
}

export class TransferReasonDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty()
  readonly code!: string;

  @ApiProperty()
  readonly name!: string;

  @ApiProperty({ type: 'string', nullable: true })
  readonly description!: string | null;

  @ApiProperty()
  readonly isActive!: boolean;

  @ApiProperty({ type: 'integer' })
  readonly sortOrder!: number;

  @ApiProperty({ type: 'integer', description: 'Ítems de traslado que lo usan; con usos no se borra, se desactiva' })
  readonly usageCount!: number;
}

export class TransferReasonDeletedDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty()
  readonly deleted!: boolean;
}
