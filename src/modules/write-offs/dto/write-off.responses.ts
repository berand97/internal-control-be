import { ApiProperty } from '@nestjs/swagger';
import { OPERATIONAL_STATUSES, type OperationalStatus } from '../../assets/enums/operational-status.enum.js';
import { DOCUMENT_STATUSES, SIGNATURE_STATUSES } from '../../documents/dto/document.responses.js';
import { WRITE_OFF_ITEM_STATES, WRITE_OFF_STATUSES, type WriteOffItemState, type WriteOffStatus } from '../domain/write-off.js';

export const WRITE_OFF_DOCUMENT_GENERATIONS = ['NONE', 'PENDING', 'FAILED', 'GENERATED', 'CANCELLED'] as const;

export class WriteOffItemStateOptionDto {
  @ApiProperty({ enum: WRITE_OFF_ITEM_STATES, enumName: 'WriteOffItemState' })
  readonly code!: WriteOffItemState;

  @ApiProperty({ example: 'Obsoleto' })
  readonly label!: string;
}

export class WriteOffPersonDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty()
  readonly name!: string;

  @ApiProperty({ type: 'string', nullable: true })
  readonly documentNumber!: string | null;
}

export class WriteOffCostCenterDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ description: 'Código externo del centro de costo' })
  readonly code!: string;

  @ApiProperty()
  readonly name!: string;
}

export class WriteOffUserDto {
  @ApiProperty({ format: 'uuid' })
  readonly userId!: string;

  @ApiProperty({ type: 'string', nullable: true })
  readonly name!: string | null;
}

export class WriteOffItemAssetDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ description: 'Columna Id del acta: id de origen o código interno' })
  readonly legacyId!: string;

  @ApiProperty({ description: 'Columna Código de barras: código visible, heredado o interno, en ese orden' })
  readonly code!: string;

  @ApiProperty()
  readonly description!: string;

  @ApiProperty({ type: 'string', nullable: true, description: 'Columna Documento: documento de compra' })
  readonly acquisitionDocument!: string | null;

  @ApiProperty({ type: 'string', format: 'date', nullable: true, description: 'Columna Fecha Compra' })
  readonly acquisitionDate!: string | null;

  @ApiProperty({ type: 'number', nullable: true, description: 'Columna Precio compra' })
  readonly acquisitionPrice!: number | null;

  @ApiProperty({ enum: OPERATIONAL_STATUSES, enumName: 'AssetOperationalStatus' })
  readonly operationalStatus!: OperationalStatus;
}

export class WriteOffItemDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ type: 'integer', description: 'Columna # del acta, desde 1' })
  readonly lineNumber!: number;

  @ApiProperty({ type: () => WriteOffItemAssetDto })
  readonly asset!: WriteOffItemAssetDto;

  @ApiProperty({ type: () => WriteOffCostCenterDto, description: 'Columna Centro: centro del activo al agregarlo a la baja' })
  readonly costCenter!: WriteOffCostCenterDto;

  @ApiProperty({ type: 'integer', description: 'Columna Cantidad' })
  readonly quantity!: number;

  @ApiProperty({ enum: WRITE_OFF_ITEM_STATES, enumName: 'WriteOffItemState', description: 'Columna Estado' })
  readonly state!: WriteOffItemState;

  @ApiProperty({ example: 'Obsoleto' })
  readonly stateLabel!: string;

  @ApiProperty({ type: 'string', nullable: true, description: 'Columna Observaciones' })
  readonly notes!: string | null;

  @ApiProperty({
    type: 'string',
    format: 'uuid',
    nullable: true,
    description: 'Movimiento WRITE_OFF que aplicó el acta firmada. null hasta COMPLETED',
  })
  readonly movementId!: string | null;
}

export class WriteOffSignatureDto {
  @ApiProperty({ type: 'integer' })
  readonly order!: number;

  @ApiProperty({ example: 'CONTROL_INTERNO' })
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

export class WriteOffDocumentDto {
  @ApiProperty({
    enum: WRITE_OFF_DOCUMENT_GENERATIONS,
    enumName: 'DocumentGenerationStatus',
    description: 'NONE en DRAFT. PENDING en cola, FAILED con lastError, GENERATED con documentId, CANCELLED si se canceló la solicitud',
  })
  readonly generation!: (typeof WRITE_OFF_DOCUMENT_GENERATIONS)[number];

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, description: 'Solicitud del outbox. Se reintenta con POST /documents/requests/:requestId/retry' })
  readonly requestId!: string | null;

  @ApiProperty({ type: 'integer' })
  readonly attempts!: number;

  @ApiProperty({ type: 'string', nullable: true, description: 'Último error de generación, solo con FAILED' })
  readonly lastError!: string | null;

  @ApiProperty({ description: 'FAILED y el job todavía la reintenta solo' })
  readonly retriesAutomatically!: boolean;

  @ApiProperty({ description: 'FAILED y se puede reencolar' })
  readonly retryable!: boolean;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, description: 'Acta generada. Firma y descarga en /documents/:id' })
  readonly documentId!: string | null;

  @ApiProperty({ type: 'string', nullable: true, example: '00020' })
  readonly number!: string | null;

  @ApiProperty({ enum: DOCUMENT_STATUSES, enumName: 'DocumentStatus', nullable: true })
  readonly status!: (typeof DOCUMENT_STATUSES)[number] | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly signedAt!: string | null;

  @ApiProperty({ type: 'string', nullable: true, description: 'El acta terminó sus firmas pero aplicar la baja falló. Se reintenta con el sync del acta' })
  readonly lifecycleError!: string | null;

  @ApiProperty({ type: [WriteOffSignatureDto], description: 'Firmantes en orden de firma, según la versión del formato' })
  readonly signatures!: WriteOffSignatureDto[];
}

export class WriteOffDetailDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ enum: WRITE_OFF_STATUSES, enumName: 'WriteOffStatus' })
  readonly status!: WriteOffStatus;

  @ApiProperty({ type: [WriteOffCostCenterDto], description: 'Centros de costo de los activos, sin repetir' })
  readonly costCenters!: WriteOffCostCenterDto[];

  @ApiProperty({ type: () => WriteOffPersonDto, nullable: true, description: 'Firma por Control Interno. null hasta generar el acta' })
  readonly controlSigner!: WriteOffPersonDto | null;

  @ApiProperty({ type: () => WriteOffPersonDto, nullable: true, description: 'Firma por Contabilidad. null hasta generar el acta' })
  readonly accountingSigner!: WriteOffPersonDto | null;

  @ApiProperty({ type: 'number', description: 'Total Informe Baja: suma del precio de compra de los activos' })
  readonly reportTotal!: number;

  @ApiProperty({ type: 'number', nullable: true, description: 'Total Autorizado Baja' })
  readonly authorizedTotal!: number | null;

  @ApiProperty({ type: 'number', nullable: true, description: 'Diferencia: total autorizado menos total informe' })
  readonly difference!: number | null;

  @ApiProperty({ type: 'string', nullable: true })
  readonly councilAgreementNumber!: string | null;

  @ApiProperty({ type: 'string', format: 'date', nullable: true })
  readonly councilAgreementDate!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  readonly vicefinanceReports!: string | null;

  @ApiProperty({ type: 'string', nullable: true, description: 'Nota del acta' })
  readonly observations!: string | null;

  @ApiProperty({ type: [WriteOffItemDto] })
  readonly items!: WriteOffItemDto[];

  @ApiProperty({ type: () => WriteOffDocumentDto })
  readonly document!: WriteOffDocumentDto;

  @ApiProperty({ type: () => WriteOffUserDto })
  readonly createdBy!: WriteOffUserDto;

  @ApiProperty({ type: 'string', format: 'date-time' })
  readonly createdAt!: string;

  @ApiProperty({ type: () => WriteOffUserDto, nullable: true })
  readonly generatedBy!: WriteOffUserDto | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly generatedAt!: string | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly completedAt!: string | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly rejectedAt!: string | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly cancelledAt!: string | null;

  @ApiProperty({ type: () => WriteOffUserDto, nullable: true })
  readonly cancelledBy!: WriteOffUserDto | null;

  @ApiProperty({ type: 'string', nullable: true })
  readonly cancelReason!: string | null;
}

export class WriteOffListItemDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ enum: WRITE_OFF_STATUSES, enumName: 'WriteOffStatus' })
  readonly status!: WriteOffStatus;

  @ApiProperty({ type: [WriteOffCostCenterDto], description: 'Centros de costo de los activos, sin repetir' })
  readonly costCenters!: WriteOffCostCenterDto[];

  @ApiProperty({ type: 'integer' })
  readonly assetCount!: number;

  @ApiProperty({ type: 'number', description: 'Total Informe Baja' })
  readonly reportTotal!: number;

  @ApiProperty({ type: 'number', nullable: true })
  readonly authorizedTotal!: number | null;

  @ApiProperty({ enum: WRITE_OFF_DOCUMENT_GENERATIONS, enumName: 'DocumentGenerationStatus' })
  readonly generation!: (typeof WRITE_OFF_DOCUMENT_GENERATIONS)[number];

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true })
  readonly documentId!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  readonly documentNumber!: string | null;

  @ApiProperty({ type: 'string', format: 'date-time' })
  readonly createdAt!: string;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly completedAt!: string | null;
}

export class WriteOffListResponseDto {
  @ApiProperty({ type: [WriteOffListItemDto] })
  readonly items!: WriteOffListItemDto[];

  @ApiProperty({ type: 'integer' })
  readonly page!: number;

  @ApiProperty({ type: 'integer' })
  readonly pageSize!: number;

  @ApiProperty({ type: 'integer' })
  readonly total!: number;

  @ApiProperty()
  readonly hasNext!: boolean;
}
