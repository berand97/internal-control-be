import { ApiProperty, ApiPropertyOptional, getSchemaPath } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger';
import { ApiSuccessEnvelope } from '../../../common/swagger/api-envelopes.js';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { DOCUMENT_LIST_STATUSES } from '../services/document-list.service.js';

/**
 * Esquemas de respuesta de /documents y /public/signatures. Solo documentan lo que el servicio ya devuelve
 * (DocumentEngineService, DocumentListService, InternalSignatureProvider): cambiar un shape exige cambiar ambos.
 */

export const DOCUMENT_STATUSES = ['PENDING_SIGNATURE', 'SIGNED', 'REJECTED'] as const;
export const SIGNATURE_STATUSES = ['PENDING', 'SIGNED', 'REJECTED'] as const;
export const STORAGE_DRIVERS = ['project', 's3', 'google_drive', 'onedrive'] as const;
export const SIGNER_SOURCES = ['RESPONSIBLE', 'REQUEST'] as const;
export const ATTESTATION_STATUSES = ['PENDING', 'COMPLETED', 'REJECTED'] as const;
export const ATTESTATION_INTEGRITIES = ['INTACT', 'ALTERED', 'UNAVAILABLE'] as const;

/** Códigos que puede traer viewer.blockedBy (DocumentEngineService.signerBlocker). */
export const SIGNER_BLOCKERS = [
  ErrorCode.InvalidState,
  ErrorCode.ResourceNotFound,
  ErrorCode.SignatureSignerUnassigned,
  ErrorCode.SignatureNotDesignatedSigner,
  ErrorCode.SignatureOutOfOrder,
  ErrorCode.SignatureSessionInvalid,
  ErrorCode.SignatureMfaRequired,
] as const;

/** `data` del envelope como arreglo de `dto` (envelopedSchema solo describe un objeto). */
export const envelopedArraySchema = (dto: Function): SchemaObject => ({
  allOf: [
    { $ref: getSchemaPath(ApiSuccessEnvelope) },
    { properties: { data: { type: 'array', items: { $ref: getSchemaPath(dto) } } } },
  ],
});

// ---------- GET /documents, POST /documents/requests/:requestId/retry ----------

export class DocumentListRequesterDto {
  @ApiProperty({ format: 'uuid' })
  readonly userId!: string;

  @ApiProperty({ type: 'string', nullable: true, description: 'Nombre de la persona del usuario, si tiene' })
  readonly name!: string | null;
}

export class DocumentListAssetDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ description: 'Código visible, código heredado o código interno, en ese orden' })
  readonly code!: string;

  @ApiProperty()
  readonly description!: string;
}

export class DocumentListItemDto {
  @ApiProperty({ format: 'uuid', description: 'documentId si ya hay documento; si no, requestId' })
  readonly id!: string;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, description: 'null mientras la solicitud no genera documento' })
  readonly documentId!: string | null;

  @ApiProperty({
    type: 'string',
    format: 'uuid',
    nullable: true,
    description: 'Solicitud del outbox; null si el documento se generó sin outbox (POST /documents)',
  })
  readonly requestId!: string | null;

  @ApiProperty({ example: 'OCI-01-55' })
  readonly formatKey!: string;

  @ApiProperty({ example: 'OCI-01-55' })
  readonly sgcCode!: string;

  @ApiProperty()
  readonly formatName!: string;

  @ApiProperty({ type: 'string', nullable: true, description: 'Consecutivo; null mientras no hay documento', example: '0093' })
  readonly number!: string | null;

  @ApiProperty({ enum: DOCUMENT_LIST_STATUSES, enumName: 'DocumentListStatus' })
  readonly status!: (typeof DOCUMENT_LIST_STATUSES)[number];

  @ApiProperty({ type: 'string', format: 'date-time' })
  readonly createdAt!: string;

  @ApiProperty({ type: () => DocumentListRequesterDto, nullable: true })
  readonly requestedBy!: DocumentListRequesterDto | null;

  @ApiProperty({ type: () => DocumentListAssetDto, nullable: true, description: 'Solo cuando el documento tiene exactamente un activo' })
  readonly asset!: DocumentListAssetDto | null;

  @ApiProperty({ type: 'integer' })
  readonly assetCount!: number;

  @ApiProperty({ type: 'string', nullable: true, description: 'Último error; solo con status FAILED' })
  readonly error!: string | null;

  @ApiProperty({ type: 'integer', nullable: true, description: 'Intentos de generación del outbox; null sin solicitud' })
  readonly attempts!: number | null;

  @ApiProperty({ description: 'FAILED y el job todavía la reintenta sola (menos de 5 intentos)' })
  readonly retriesAutomatically!: boolean;

  @ApiProperty({ description: 'FAILED: se puede reencolar con POST /documents/requests/:requestId/retry' })
  readonly retryable!: boolean;
}

export class DocumentListResponseDto {
  @ApiProperty({ type: [DocumentListItemDto] })
  readonly items!: DocumentListItemDto[];

  @ApiProperty({ type: 'integer' })
  readonly page!: number;

  @ApiProperty({ type: 'integer' })
  readonly pageSize!: number;

  @ApiProperty({ type: 'integer' })
  readonly total!: number;

  @ApiProperty()
  readonly hasNext!: boolean;
}

// ---------- GET /documents/formats ----------

export class DocumentFormatNumberingDto {
  @ApiProperty({ type: 'integer', description: 'Dígitos del consecutivo' })
  readonly width!: number;

  @ApiProperty({ description: 'El consecutivo reinicia cada año y se imprime AAAA-NNNN' })
  readonly perYear!: boolean;

  @ApiProperty({ type: 'integer', description: 'Último número emitido antes de que el sistema llevara el consecutivo' })
  readonly lastIssued!: number;

  @ApiPropertyOptional({
    type: 'string',
    description: 'Año de lastIssued. Solo existe en formatos con consecutivo anual; en los demás la propiedad no viene',
    example: '2026',
  })
  readonly lastIssuedPeriod?: string;
}

export class DocumentFormatSignerDto {
  @ApiProperty({ type: 'integer' })
  readonly order!: number;

  @ApiProperty({ example: 'RECIBE' })
  readonly role!: string;

  @ApiProperty({ example: 'Recibe' })
  readonly label!: string;

  @ApiProperty({
    enum: SIGNER_SOURCES,
    enumName: 'DocumentSignerSource',
    description: 'RESPONSIBLE: el responsable de la solicitud; REQUEST: se indica en signers[rol]',
  })
  readonly source!: (typeof SIGNER_SOURCES)[number];
}

export class DocumentActiveTemplateDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty({ description: 'Versión SGC de la plantilla' })
  readonly version!: string;

  @ApiProperty({ type: 'string', format: 'date', example: '2026-09-08' })
  readonly effectiveDate!: string;
}

export class DocumentFormatResponseDto {
  @ApiProperty({ example: 'OCI-17-90-BAJA' })
  readonly key!: string;

  @ApiProperty({ example: 'OCI-17-90' })
  readonly sgcCode!: string;

  @ApiProperty({ description: 'Versión SGC declarada en el catálogo del backend' })
  readonly version!: string;

  @ApiProperty()
  readonly name!: string;

  @ApiProperty({ type: () => DocumentFormatNumberingDto })
  readonly numbering!: DocumentFormatNumberingDto;

  @ApiProperty({ example: 'asset:read:global' })
  readonly readPermission!: string;

  @ApiProperty({ example: 'asset:update:global' })
  readonly generatePermission!: string;

  @ApiProperty({ type: [DocumentFormatSignerDto] })
  readonly signers!: DocumentFormatSignerDto[];

  @ApiProperty({ type: [String] })
  readonly pendingDecisions!: string[];

  @ApiProperty({ type: () => DocumentActiveTemplateDto, nullable: true, description: 'null si no hay plantilla vigente hoy' })
  readonly activeTemplate!: DocumentActiveTemplateDto | null;

  @ApiProperty({ type: 'integer', nullable: true, description: 'Valor actual del consecutivo del periodo en curso; null si aún no existe' })
  readonly lastIssuedNumber!: number | null;
}

// ---------- POST /documents/formats/:formatKey/templates ----------

export class UploadedTemplateResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty()
  readonly formatKey!: string;

  @ApiProperty({ type: [String], description: 'Placeholders encontrados en la plantilla' })
  readonly placeholders!: string[];
}

// ---------- POST /documents ----------

export class GeneratedDocumentResponseDto {
  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty()
  readonly formatKey!: string;

  @ApiProperty({ example: '0093' })
  readonly number!: string;

  @ApiProperty({ enum: ['PENDING_SIGNATURE'], description: 'Un documento recién generado siempre queda pendiente de firma' })
  readonly status!: 'PENDING_SIGNATURE';

  @ApiProperty({ enum: STORAGE_DRIVERS, enumName: 'StorageDriver' })
  readonly pdfDriver!: (typeof STORAGE_DRIVERS)[number];

  @ApiProperty({ description: 'Clave del PDF en el almacenamiento' })
  readonly pdfKey!: string;
}

// ---------- GET /documents/:id (y sign / reject / reassign / sync) ----------

export class DocumentCurrentTurnDto {
  @ApiProperty({ type: 'integer' })
  readonly order!: number;

  @ApiProperty()
  readonly role!: string;

  @ApiProperty()
  readonly roleLabel!: string;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true })
  readonly personId!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  readonly name!: string | null;

  @ApiProperty({ description: 'El turno tiene una persona asignada' })
  readonly assigned!: boolean;
}

export class DocumentViewerDto {
  @ApiProperty({ format: 'uuid' })
  readonly personId!: string;

  @ApiProperty({ type: 'integer', isArray: true, description: 'Turnos del documento asignados al usuario' })
  readonly signerOrders!: number[];

  @ApiProperty({ description: 'Es el turno del usuario ahora' })
  readonly isCurrentSigner!: boolean;

  @ApiProperty({ type: 'integer', nullable: true, description: 'Próximo turno pendiente del usuario' })
  readonly nextOrder!: number | null;

  @ApiProperty({ description: 'Puede firmar nextOrder ya' })
  readonly canSign!: boolean;

  @ApiProperty({
    type: 'string',
    enum: SIGNER_BLOCKERS,
    enumName: 'DocumentSignerBlocker',
    nullable: true,
    description:
      'Código de error que recibiría al firmar nextOrder. null si canSign o si el usuario no tiene turnos pendientes',
  })
  readonly blockedBy!: (typeof SIGNER_BLOCKERS)[number] | null;

  @ApiProperty({ description: 'Puede reasignar turnos: acta pendiente y permiso de generación del formato' })
  readonly canReassign!: boolean;
}

export class DocumentVerificationDto {
  @ApiProperty({ description: 'Código público de verificación' })
  readonly code!: string;

  @ApiProperty({ description: 'URL pública de verificación (la del QR)' })
  readonly url!: string;
}

export class DocumentReassignmentDto {
  @ApiProperty({ type: 'integer' })
  readonly order!: number;

  @ApiProperty()
  readonly role!: string;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, description: 'null si el turno no tenía persona' })
  readonly fromPersonId!: string | null;

  @ApiProperty({ format: 'uuid' })
  readonly toPersonId!: string;

  @ApiProperty({ type: 'string', nullable: true })
  readonly fromName!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  readonly toName!: string | null;

  @ApiProperty()
  readonly reason!: string;

  @ApiProperty({ format: 'uuid', description: 'Usuario que reasignó' })
  readonly reassignedBy!: string;

  @ApiProperty({ type: 'string', format: 'date-time' })
  readonly reassignedAt!: string;

  @ApiProperty({ type: 'string', nullable: true, description: 'SHA-256 del PDF antes de reemitir; null en registros previos a la reemisión' })
  readonly previousPdfSha256!: string | null;

  @ApiProperty({ type: 'string', nullable: true, description: 'SHA-256 del PDF reemitido; null en registros previos a la reemisión' })
  readonly newPdfSha256!: string | null;
}

export class DocumentSignatureDto {
  @ApiProperty({ type: 'integer' })
  readonly order!: number;

  @ApiProperty()
  readonly role!: string;

  @ApiProperty()
  readonly roleLabel!: string;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true })
  readonly personId!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  readonly name!: string | null;

  @ApiProperty({ enum: SIGNATURE_STATUSES, enumName: 'DocumentSignatureStatus' })
  readonly status!: (typeof SIGNATURE_STATUSES)[number];

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true, description: 'Cuándo firmó o rechazó' })
  readonly signedAt!: string | null;
}

export class DocumentDetailResponseDto {
  @ApiProperty({ type: () => DocumentCurrentTurnDto, nullable: true, description: 'null si el acta no está pendiente de firma' })
  readonly currentTurn!: DocumentCurrentTurnDto | null;

  @ApiProperty({ type: () => DocumentViewerDto, description: 'Qué puede hacer el usuario que consulta' })
  readonly viewer!: DocumentViewerDto;

  @ApiProperty({
    type: () => DocumentVerificationDto,
    nullable: true,
    description: 'null si aún no se pidió la firma o el proveedor no tiene verificación pública',
  })
  readonly verification!: DocumentVerificationDto | null;

  @ApiProperty({ type: [DocumentReassignmentDto], description: 'Bitácora de reasignaciones, más antiguas primero' })
  readonly reassignments!: DocumentReassignmentDto[];

  @ApiProperty({ format: 'uuid' })
  readonly id!: string;

  @ApiProperty()
  readonly formatKey!: string;

  @ApiProperty()
  readonly number!: string;

  @ApiProperty({ enum: DOCUMENT_STATUSES, enumName: 'DocumentStatus' })
  readonly status!: (typeof DOCUMENT_STATUSES)[number];

  @ApiProperty({ type: 'string', nullable: true, description: 'Proceso que originó el acta' })
  readonly entityType!: string | null;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true })
  readonly entityId!: string | null;

  @ApiProperty({ enum: STORAGE_DRIVERS, enumName: 'StorageDriver' })
  readonly pdfDriver!: (typeof STORAGE_DRIVERS)[number];

  @ApiProperty({ type: 'string', nullable: true, example: 'internal' })
  readonly signatureProvider!: string | null;

  @ApiProperty({ description: 'SHA-256 del PDF generado (sin firmas)' })
  readonly pdfSha256!: string;

  @ApiProperty({ type: 'string', nullable: true, description: 'SHA-256 del PDF firmado; null hasta que el acta queda SIGNED' })
  readonly signedPdfSha256!: string | null;

  @ApiProperty({ type: [DocumentSignatureDto] })
  readonly signatures!: DocumentSignatureDto[];

  @ApiProperty({
    type: 'string',
    nullable: true,
    description:
      'Error del proceso que originó el acta al aplicar sus efectos (firma completa o rechazo). Mientras exista, el acta sigue PENDING_SIGNATURE aunque tenga todas las firmas y se reintenta con POST /documents/:id/signatures/sync (y el job, hasta 5 veces)',
  })
  readonly lifecycleError!: string | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly lifecycleFailedAt!: string | null;
}

// ---------- GET /public/signatures/:code ----------

export class AttestationSignerDto {
  @ApiProperty({ type: 'integer' })
  readonly order!: number;

  @ApiProperty({ description: 'Etiqueta del rol (Recibe, Control Interno...)' })
  readonly role!: string;

  @ApiProperty({ type: 'string', nullable: true, description: 'null mientras el turno está pendiente' })
  readonly name!: string | null;

  @ApiProperty({ enum: SIGNATURE_STATUSES, enumName: 'DocumentSignatureStatus' })
  readonly status!: (typeof SIGNATURE_STATUSES)[number];

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly signedAt!: string | null;
}

export class SignatureAttestationResponseDto {
  @ApiProperty({ description: 'El código de verificación consultado' })
  readonly reference!: string;

  @ApiProperty({ enum: ATTESTATION_STATUSES, enumName: 'AttestationStatus' })
  readonly status!: (typeof ATTESTATION_STATUSES)[number];

  @ApiProperty({ enum: ATTESTATION_INTEGRITIES, enumName: 'AttestationIntegrity' })
  readonly integrity!: (typeof ATTESTATION_INTEGRITIES)[number];

  @ApiProperty({ description: 'SHA-256 del PDF vigente del sobre de firma' })
  readonly documentSha256!: string;

  @ApiProperty({ type: [AttestationSignerDto] })
  readonly signers!: AttestationSignerDto[];

  @ApiProperty({ type: 'string', format: 'date-time' })
  readonly checkedAt!: string;
}

export const DOCUMENT_RESPONSE_MODELS = [
  ApiSuccessEnvelope,
  DocumentListResponseDto,
  DocumentListItemDto,
  DocumentFormatResponseDto,
  UploadedTemplateResponseDto,
  GeneratedDocumentResponseDto,
  DocumentDetailResponseDto,
  SignatureAttestationResponseDto,
] as const;
