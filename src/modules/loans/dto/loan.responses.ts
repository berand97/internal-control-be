import { ApiProperty } from '@nestjs/swagger';
import { ApiSuccessEnvelope } from '../../../common/swagger/api-envelopes.js';
import { DOCUMENT_STATUSES } from '../../documents/dto/document.responses.js';
import { LOAN_RETURN_CONDITIONS, LOAN_STATUSES } from '../enums/loan-status.js';

/**
 * Esquemas de respuesta de /loans. Solo documentan lo que LoansService devuelve: cambiar un shape exige cambiar
 * ambos (test/integration/loans.int-spec.ts compara las llaves).
 */

export const LOAN_DELIVERY_ACT_STATUSES = [
  'NONE',
  'PENDING',
  'FAILED',
  'GENERATED',
  'SIGNED',
  'REJECTED',
  'VOIDED',
  'CANCELLED',
] as const;
export type LoanDeliveryActStatus = (typeof LOAN_DELIVERY_ACT_STATUSES)[number];

export const LOAN_RETURN_ACT_STATUSES = [
  'PENDING_FORMAT',
  'PENDING',
  'FAILED',
  'GENERATED',
  'SIGNED',
  'REJECTED',
  'VOIDED',
  'CANCELLED',
] as const;
export type LoanReturnActStatus = (typeof LOAN_RETURN_ACT_STATUSES)[number];

export const LOAN_STATUS_DESCRIPTION =
  'REQUESTED → APPROVED → PENDING_SIGNATURES (entregado: activos ON_LOAN, acta OCI-01-65 sin todas sus firmas) → ACTIVE (acta firmada) ' +
  '→ OVERDUE → PENDING_RECEPTION → RETURNED | PARTIALLY_RETURNED (quedan activos fuera; admite otra devolución) | CLOSED_WITH_LOSSES ' +
  '(todo resuelto, alguno perdido). REJECTED y CANCELLED (solicitud cancelada o entrega deshecha) son finales. IN_TRANSIT: heredado, sin uso.';

export class LoanUsageDto {
  @ApiProperty({ type: 'integer' })
  readonly years!: number;

  @ApiProperty({ type: 'integer' })
  readonly months!: number;

  @ApiProperty({ type: 'integer' })
  readonly days!: number;

  @ApiProperty({ type: 'integer', description: 'Días calendario entre las dos fechas' })
  readonly totalDays!: number;

  @ApiProperty({ example: '0 años, 8 meses, 14 días' })
  readonly text!: string;
}

export class LoanSummaryDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ enum: LOAN_STATUSES, enumName: 'LoanStatus', description: LOAN_STATUS_DESCRIPTION })
  readonly status!: (typeof LOAN_STATUSES)[number];

  @ApiProperty({
    format: 'uuid',
    description: 'Centro de costo de origen: dueño de los activos. El acta usa este centro y el responsable de los activos no cambia',
  })
  readonly sourceCostCenterId!: string;

  @ApiProperty({ format: 'uuid', description: 'Dependencia a la que se presta: el préstamo se otorga a ella, no a una persona' })
  readonly targetCostCenterId!: string;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true })
  readonly targetLocationId!: string | null;

  @ApiProperty({
    type: 'string',
    format: 'uuid',
    nullable: true,
    description: 'Persona de contacto en el destino (asset_loan.target_responsible_id); firma RECIBE del acta. No pasa a ser responsable de los activos',
  })
  readonly contactPersonId!: string | null;

  @ApiProperty({ type: 'string', format: 'date', example: '2026-12-11' })
  readonly expectedReturnDate!: string;

  @ApiProperty()
  readonly justification!: string;

  @ApiProperty({ type: 'string', nullable: true })
  readonly deliveryNotes!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  readonly returnNotes!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  readonly rejectedReason!: string | null;

  @ApiProperty({ format: 'uuid', description: 'Usuario que solicitó' })
  readonly requestedBy!: string;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true })
  readonly approvedBy!: string | null;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true })
  readonly deliveredBy!: string | null;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true })
  readonly receivedBackBy!: string | null;

  @ApiProperty({ type: 'string', format: 'date-time' })
  readonly requestedAt!: string;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly approvedAt!: string | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true, description: 'Entrega física (los activos salieron)' })
  readonly deliveredAt!: string | null;

  @ApiProperty({
    type: 'string',
    format: 'date-time',
    nullable: true,
    description: 'Fecha real de devolución: la última fecha real de los activos devueltos',
  })
  readonly actualReturnDate!: string | null;

  @ApiProperty({
    type: 'string',
    format: 'date',
    nullable: true,
    description: 'Extensión pedida por el solicitante y pendiente de aprobación (POST /loans/:id/extension/approve | reject)',
  })
  readonly extensionRequestedDate!: string | null;

  @ApiProperty({
    type: 'string',
    format: 'uuid',
    nullable: true,
    description: 'Acta OCI-01-65 vigente de la entrega (la última generada), una vez generada',
  })
  readonly deliveryDocumentId!: string | null;

  @ApiProperty({
    type: () => LoanUsageDto,
    nullable: true,
    description: 'Tiempo de uso estimado: fecha de entrega → fecha estimada de devolución (el del acta). null sin entrega',
  })
  readonly estimatedUsage!: LoanUsageDto | null;

  @ApiProperty({
    type: () => LoanUsageDto,
    nullable: true,
    description: 'Tiempo de uso real: fecha de entrega → fecha real de devolución, o hasta hoy si no ha vuelto. null sin entrega',
  })
  readonly actualUsage!: LoanUsageDto | null;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    description:
      'Días de atraso (hoy en Bogotá − fecha estimada) para PENDING_SIGNATURES, ACTIVE, OVERDUE y PARTIALLY_RETURNED; 0 si no ha vencido; null en otro estado',
  })
  readonly daysOverdue!: number | null;

  @ApiProperty({ type: 'string', format: 'date-time' })
  readonly createdAt!: string;

  @ApiProperty({ type: 'string', format: 'date-time' })
  readonly updatedAt!: string;
}

export class LoanListResponseDto {
  @ApiProperty({ type: [LoanSummaryDto] })
  readonly items!: LoanSummaryDto[];

  @ApiProperty({ type: 'integer' })
  readonly page!: number;

  @ApiProperty({ type: 'integer' })
  readonly pageSize!: number;

  @ApiProperty({ type: 'integer' })
  readonly total!: number;

  @ApiProperty()
  readonly hasNext!: boolean;
}

export class LoanItemDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ format: 'uuid' })
  readonly loanId!: string;

  @ApiProperty({ format: 'uuid' })
  readonly assetId!: string;

  @ApiProperty({ type: 'string', nullable: true })
  readonly internalCode!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  readonly description!: string | null;

  @ApiProperty({ format: 'uuid' })
  readonly sourceCostCenterId!: string;

  @ApiProperty({ type: 'string', nullable: true, description: 'Estado operativo del activo antes del préstamo; se restituye al recibirlo' })
  readonly statusOnLoan!: string | null;

  @ApiProperty({ type: 'string', nullable: true, description: 'Condición física del activo en la entrega' })
  readonly conditionOnDelivery!: string | null;

  @ApiProperty({ enum: LOAN_RETURN_CONDITIONS, enumName: 'LoanReturnCondition', nullable: true })
  readonly returnCondition!: (typeof LOAN_RETURN_CONDITIONS)[number] | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true, description: 'Fecha real de devolución del activo' })
  readonly returnedAt!: string | null;

  @ApiProperty({
    type: 'string',
    format: 'date-time',
    nullable: true,
    description: 'Cuándo el origen recibió la devolución del activo (receive-return); null mientras no se recibe',
  })
  readonly receivedAt!: string | null;

  @ApiProperty({ description: 'El activo salió y todavía no se resolvió (ni devuelto ni declarado perdido)' })
  readonly outstanding!: boolean;
}

export class LoanEventDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ format: 'uuid' })
  readonly loanId!: string;

  @ApiProperty({
    example: 'DELIVERED',
    description:
      'REQUESTED, APPROVED, REJECTED, DELIVERED, DELIVERY_ACT_GENERATED, DELIVERY_ACT_SIGNED (payload.activated: el préstamo pasó a ACTIVE), ' +
      'DELIVERY_ACT_REJECTED, DELIVERY_ACT_REGENERATED, DELIVERY_UNDONE, RETURN_STARTED, RECEIVED (payload.returnAct), RETURN_ACT_GENERATED, ' +
      'RETURN_ACT_SIGNED, RETURN_ACT_REJECTED, EXTENSION_REQUESTED, EXTENDED, EXTENSION_REJECTED',
  })
  readonly eventType!: string;

  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true })
  readonly payload!: Record<string, unknown> | null;

  @ApiProperty({ format: 'uuid', description: 'Usuario' })
  readonly performedBy!: string;

  @ApiProperty({ type: 'string', format: 'date-time' })
  readonly createdAt!: string;
}

export class LoanAttachmentDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ format: 'uuid' })
  readonly loanId!: string;

  @ApiProperty()
  readonly kind!: string;

  @ApiProperty()
  readonly storageKey!: string;

  @ApiProperty()
  readonly fileHash!: string;

  @ApiProperty({ type: 'string', format: 'date-time' })
  readonly createdAt!: string;

  @ApiProperty({ format: 'uuid' })
  readonly createdBy!: string;
}

export class LoanActRecordDto {
  @ApiProperty({ format: 'uuid' })
  readonly documentId!: string;

  @ApiProperty({ example: '2026-0002' })
  readonly number!: string;

  @ApiProperty({ enum: DOCUMENT_STATUSES, enumName: 'DocumentStatus' })
  readonly status!: (typeof DOCUMENT_STATUSES)[number];

  @ApiProperty({ type: 'string', format: 'date-time' })
  readonly createdAt!: string;
}

export class LoanDeliveryActDto {
  @ApiProperty({
    enum: LOAN_DELIVERY_ACT_STATUSES,
    enumName: 'LoanDeliveryActStatus',
    description:
      'NONE: sin entrega. PENDING: en el outbox. FAILED: la generación falló (ver error; se reintenta con POST /documents/requests/:requestId/retry). ' +
      'GENERATED: pendiente de firma. SIGNED: firmada (el préstamo quedó ACTIVE). REJECTED: rechazada (el préstamo sigue PENDING_SIGNATURES; ' +
      'POST /loans/:id/delivery-act/regenerate genera otra, o POST /loans/:id/undo-delivery deshace la entrega). VOIDED / CANCELLED: anulada al deshacer la entrega.',
  })
  readonly status!: LoanDeliveryActStatus;

  @ApiProperty({ example: 'OCI-01-65' })
  readonly formatKey!: string;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, description: 'Solicitud del outbox más reciente' })
  readonly requestId!: string | null;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true })
  readonly documentId!: string | null;

  @ApiProperty({ type: 'string', nullable: true, example: '2026-0002' })
  readonly number!: string | null;

  @ApiProperty({ type: 'integer', description: 'Intentos de generación de la solicitud más reciente' })
  readonly attempts!: number;

  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'FAILED: último error de generación. Con acta: error del proceso al completarla (lifecycleError), si lo hay',
  })
  readonly error!: string | null;

  @ApiProperty({ description: 'FAILED: se puede reencolar con POST /documents/requests/:requestId/retry' })
  readonly retryable!: boolean;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly signedAt!: string | null;

  @ApiProperty({ description: 'REJECTED y el préstamo PENDING_SIGNATURES: se puede generar una nueva acta (nuevo consecutivo)' })
  readonly regenerable!: boolean;

  @ApiProperty({
    type: [LoanActRecordDto],
    description: 'Actas de entrega anteriores del préstamo (rechazadas o anuladas), más recientes primero; quedan como registro',
  })
  readonly previous!: LoanActRecordDto[];
}

export class LoanReturnActFormatDto {
  @ApiProperty({ example: 'LOAN_RETURN', description: 'Clave interna del formato' })
  readonly formatKey!: string;

  @ApiProperty({ type: 'string', nullable: true, description: 'Código SGC; null mientras la universidad no lo emita' })
  readonly sgcCode!: string | null;

  @ApiProperty({ description: 'El motor puede generar el acta (código SGC y firmantes definidos)' })
  readonly ready!: boolean;

  @ApiProperty({ type: [String], description: 'Lo que falta definir; la UI lo muestra como "pendiente de formato institucional"' })
  readonly pendingDecisions!: string[];
}

export class LoanReturnActDto {
  @ApiProperty({
    enum: LOAN_RETURN_ACT_STATUSES,
    enumName: 'LoanReturnActStatus',
    description:
      'PENDING_FORMAT: la devolución se registró pero el acta no se generó porque el formato institucional no existe (ver returnActFormat). ' +
      'PENDING / FAILED / GENERATED / SIGNED / REJECTED / VOIDED / CANCELLED: como el acta de entrega.',
  })
  readonly status!: LoanReturnActStatus;

  @ApiProperty({ type: 'string', format: 'date-time', description: 'Recepción (receive-return) que originó el acta' })
  readonly receivedAt!: string;

  @ApiProperty({ type: [String], description: 'Activos (uuid) recibidos en esa recepción' })
  readonly assetIds!: string[];

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true })
  readonly requestId!: string | null;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true })
  readonly documentId!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  readonly number!: string | null;

  @ApiProperty({ type: 'integer' })
  readonly attempts!: number;

  @ApiProperty({ type: 'string', nullable: true, description: 'FAILED: último error. PENDING_FORMAT: qué falta del formato' })
  readonly error!: string | null;

  @ApiProperty({ description: 'FAILED: se puede reencolar con POST /documents/requests/:requestId/retry' })
  readonly retryable!: boolean;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly signedAt!: string | null;
}

export class LoanDetailDto extends LoanSummaryDto {
  @ApiProperty({ type: [LoanItemDto] })
  readonly items!: LoanItemDto[];

  @ApiProperty({ type: [LoanEventDto], description: 'En orden cronológico' })
  readonly events!: LoanEventDto[];

  @ApiProperty({ type: [LoanAttachmentDto], description: 'Adjuntos del catálogo anterior; las actas nuevas están en deliveryAct y returnActs' })
  readonly attachments!: LoanAttachmentDto[];

  @ApiProperty({ type: () => LoanDeliveryActDto })
  readonly deliveryAct!: LoanDeliveryActDto;

  @ApiProperty({ type: () => LoanReturnActFormatDto, description: 'Estado del formato del acta de devolución en el catálogo' })
  readonly returnActFormat!: LoanReturnActFormatDto;

  @ApiProperty({ type: [LoanReturnActDto], description: 'Un acta de devolución por recepción, en orden cronológico' })
  readonly returnActs!: LoanReturnActDto[];
}

export const LOAN_RESPONSE_MODELS = [
  ApiSuccessEnvelope,
  LoanUsageDto,
  LoanSummaryDto,
  LoanListResponseDto,
  LoanItemDto,
  LoanEventDto,
  LoanAttachmentDto,
  LoanActRecordDto,
  LoanDeliveryActDto,
  LoanReturnActFormatDto,
  LoanReturnActDto,
  LoanDetailDto,
] as const;
