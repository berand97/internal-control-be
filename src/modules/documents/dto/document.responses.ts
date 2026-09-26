import { ApiProperty, ApiPropertyOptional, getSchemaPath } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger';
import { ApiSuccessEnvelope } from '../../../common/swagger/api-envelopes.js';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { SIGNATURE_METHODS, TURN_BLOCKERS } from '../domain/signing-channel.js';
import { DOCUMENT_LIST_STATUSES } from '../services/document-list.service.js';

/**
 * Esquemas de respuesta de /documents y /public/signatures. Solo documentan lo que el servicio ya devuelve
 * (DocumentEngineService, DocumentListService, InternalSignatureProvider): cambiar un shape exige cambiar ambos.
 */

export const DOCUMENT_STATUSES = ['PENDING_SIGNATURE', 'SIGNED', 'REJECTED', 'VOIDED'] as const;
export const SIGNATURE_STATUSES = ['PENDING', 'SIGNED', 'REJECTED'] as const;
export const STORAGE_DRIVERS = ['project', 's3', 'google_drive', 'onedrive'] as const;
export const SIGNER_SOURCES = ['RESPONSIBLE', 'REQUEST'] as const;
export const ATTESTATION_STATUSES = ['PENDING', 'SIGNATURES_COLLECTED', 'COMPLETED', 'REJECTED', 'VOIDED'] as const;
export const SIGNING_LINK_STATES = ['PENDING_SEND', 'SENT', 'SEND_FAILED', 'EXPIRED', 'CONSUMED', 'INVALIDATED'] as const;
export const SIGNING_LINK_INVALIDATIONS = ['RESENT', 'ATTEMPTS_EXCEEDED', 'REASSIGNED', 'VOIDED', 'TURN_CHANGED'] as const;
export const SIGNING_LINK_ACTIONS = ['SIGNED', 'REJECTED'] as const;
export const PUBLIC_LINK_STATUSES = ['ACTIVE', 'EXPIRED', 'CONSUMED', 'INVALIDATED'] as const;

const METHOD_DESCRIPTION =
  'SESSION_MFA: sesión con verificación en dos pasos; SESSION: sesión; EMAIL_LINK: enlace de un solo uso enviado al correo institucional';
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

  @ApiProperty({
    type: 'string',
    nullable: true,
    description:
      'Error del proceso que originó el acta al aplicar sus efectos; mientras exista el acta sigue PENDING_SIGNATURE y se reintenta. null en solicitudes sin documento',
  })
  readonly lifecycleError!: string | null;
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

  @ApiProperty({
    type: 'string',
    enum: SIGNATURE_METHODS,
    enumName: 'SignatureMethod',
    nullable: true,
    description: `Camino por el que firma la persona del turno. ${METHOD_DESCRIPTION}. null si el turno está bloqueado`,
  })
  readonly channel!: (typeof SIGNATURE_METHODS)[number] | null;

  @ApiProperty({
    type: 'string',
    enum: TURN_BLOCKERS,
    enumName: 'DocumentTurnBlocker',
    nullable: true,
    description:
      'Por qué nadie puede firmar este turno ahora: SIGNATURE_SIGNER_UNASSIGNED, SIGNATURE_SIGNER_INACTIVE, SIGNATURE_NO_CHANNEL (sin usuario activo ni correo, o turno de Control Interno sin usuario activo), SIGNATURE_NO_IDENTITY_CHECK (sin usuario activo y sin número de documento para confirmar identidad), SIGNATURE_MFA_REQUIRED (turno de Control Interno con usuario sin MFA). Se resuelve reasignando el turno o completando los datos de la persona',
  })
  readonly blockedBy!: (typeof TURN_BLOCKERS)[number] | null;
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

  @ApiProperty({
    description: 'Puede reasignar turnos: acta pendiente, ningún turno firmado ni rechazado y permiso de generación del formato',
  })
  readonly canReassign!: boolean;

  @ApiProperty({
    description:
      'Puede reenviar el enlace de firma del turno actual (POST /documents/:id/signatures/:order/signing-link): permiso de generación del formato y turno actual por EMAIL_LINK',
  })
  readonly canResendLink!: boolean;
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

export class DocumentSigningLinkDto {
  @ApiProperty({
    enum: SIGNING_LINK_STATES,
    enumName: 'SigningLinkState',
    description:
      'PENDING_SEND: en cola de envío; SENT: enviado y vigente; SEND_FAILED: el correo falló (lastSendError), se reintenta solo hasta 3 veces y luego hay que reenviarlo; EXPIRED: venció (72 h); CONSUMED: se usó para firmar o rechazar; INVALIDATED: reemplazado, bloqueado por intentos, reasignado, turno cambiado o acta anulada (invalidatedReason)',
  })
  readonly status!: (typeof SIGNING_LINK_STATES)[number];

  @ApiProperty({ description: 'Correo institucional al que se envía' })
  readonly email!: string;

  @ApiProperty({ type: 'integer' })
  readonly sendAttempts!: number;

  @ApiProperty({ type: 'string', nullable: true, description: 'Último error de envío; solo si el envío falló' })
  readonly lastSendError!: string | null;

  @ApiProperty({ type: 'string', format: 'date-time' })
  readonly createdAt!: string;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly sentAt!: string | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true, description: 'null mientras no se ha emitido' })
  readonly expiresAt!: string | null;

  @ApiProperty({ type: 'integer', description: 'Intentos fallidos de confirmar identidad (al quinto se invalida)' })
  readonly identityAttempts!: number;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly identityConfirmedAt!: string | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly consumedAt!: string | null;

  @ApiProperty({ type: 'string', enum: SIGNING_LINK_ACTIONS, enumName: 'SigningLinkAction', nullable: true })
  readonly consumedAction!: (typeof SIGNING_LINK_ACTIONS)[number] | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly invalidatedAt!: string | null;

  @ApiProperty({
    type: 'string',
    enum: SIGNING_LINK_INVALIDATIONS,
    enumName: 'SigningLinkInvalidation',
    nullable: true,
  })
  readonly invalidatedReason!: (typeof SIGNING_LINK_INVALIDATIONS)[number] | null;
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

  @ApiProperty({
    type: 'string',
    enum: SIGNATURE_METHODS,
    enumName: 'SignatureMethod',
    nullable: true,
    description: `Método con el que firmó o rechazó. ${METHOD_DESCRIPTION}. null mientras está pendiente`,
  })
  readonly method!: (typeof SIGNATURE_METHODS)[number] | null;

  @ApiProperty({ type: 'string', nullable: true, description: 'El método en lenguaje claro' })
  readonly methodLabel!: string | null;

  @ApiProperty({
    type: () => DocumentSigningLinkDto,
    nullable: true,
    description: 'Último enlace de firma por correo de este turno; null si nunca se emitió. Nunca trae el token',
  })
  readonly signingLink!: DocumentSigningLinkDto | null;
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

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true, description: 'Solo con status VOIDED' })
  readonly voidedAt!: string | null;

  @ApiProperty({
    type: 'string',
    format: 'uuid',
    nullable: true,
    description: 'Usuario que anuló; null si no es VOIDED o si lo anuló un proceso sin usuario',
  })
  readonly voidedBy!: string | null;

  @ApiProperty({ type: 'string', nullable: true, description: 'Motivo de la anulación (el proceso que originó el acta se canceló)' })
  readonly voidReason!: string | null;
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

  @ApiProperty({
    type: 'string',
    enum: SIGNATURE_METHODS,
    enumName: 'SignatureMethod',
    nullable: true,
    description: `${METHOD_DESCRIPTION}. null mientras el turno está pendiente`,
  })
  readonly method!: (typeof SIGNATURE_METHODS)[number] | null;

  @ApiProperty({
    type: 'string',
    nullable: true,
    example: 'Enlace de un solo uso enviado al correo institucional',
    description: 'El método en lenguaje claro',
  })
  readonly methodLabel!: string | null;
}

export class SignatureAttestationResponseDto {
  @ApiProperty({ description: 'El código de verificación consultado' })
  readonly reference!: string;

  @ApiProperty({
    enum: ATTESTATION_STATUSES,
    enumName: 'AttestationStatus',
    description:
      'PENDING: faltan firmas. SIGNATURES_COLLECTED: están todas las firmas pero el acta aún no está cerrada (el proceso que la originó todavía no la acepta; se reintenta): NO es un acta firmada y vigente. COMPLETED: acta firmada y cerrada. REJECTED: un firmante la rechazó. VOIDED: el proceso que la originó la anuló',
  })
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

// ---------- /public/signing-links/:token ----------

export class SigningLinkDocumentDto {
  @ApiProperty({ example: 'OCI-01-55' })
  readonly sgcCode!: string;

  @ApiProperty({ example: 'Acta de entrega y asignación de activos fijos' })
  readonly formatName!: string;

  @ApiProperty({ example: '0093' })
  readonly number!: string;
}

export class SigningLinkTurnDto {
  @ApiProperty({ type: 'integer' })
  readonly order!: number;

  @ApiProperty({ example: 'Recibe' })
  readonly roleLabel!: string;
}

export class SigningLinkViewResponseDto {
  @ApiProperty({
    enum: PUBLIC_LINK_STATUSES,
    enumName: 'PublicSigningLinkStatus',
    description:
      'ACTIVE: se puede leer, confirmar identidad y firmar o rechazar. EXPIRED: venció. CONSUMED: ya se usó (consumedAction). INVALIDATED: se reenvió otro, se agotaron los intentos, se reasignó el turno, el acta ya no está pendiente o se anuló',
  })
  readonly status!: (typeof PUBLIC_LINK_STATUSES)[number];

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  readonly expiresAt!: string | null;

  @ApiProperty({ type: 'string', enum: SIGNING_LINK_ACTIONS, enumName: 'SigningLinkAction', nullable: true })
  readonly consumedAction!: (typeof SIGNING_LINK_ACTIONS)[number] | null;

  @ApiProperty({ type: 'integer', description: 'Intentos que quedan para confirmar identidad (de 5)' })
  readonly identityAttemptsRemaining!: number;

  @ApiProperty({ type: () => SigningLinkDocumentDto, nullable: true, description: 'Solo con status ACTIVE' })
  readonly document!: SigningLinkDocumentDto | null;

  @ApiProperty({ type: () => SigningLinkTurnDto, nullable: true, description: 'Solo con status ACTIVE' })
  readonly turn!: SigningLinkTurnDto | null;

  @ApiProperty({
    type: 'string',
    nullable: true,
    example: 'Laura R. E.',
    description: 'Nombre del firmante con los apellidos en iniciales; solo con status ACTIVE',
  })
  readonly signerName!: string | null;
}

export class SigningLinkIdentityResponseDto {
  @ApiProperty({
    description: 'Autorización para POST sign o reject de este enlace. No la guarde ni la registre',
  })
  readonly identityToken!: string;

  @ApiProperty({ type: 'string', format: 'date-time', description: 'Vence a los 10 minutos' })
  readonly expiresAt!: string;
}

export class SigningLinkResultResponseDto {
  @ApiProperty({ enum: SIGNING_LINK_ACTIONS, enumName: 'SigningLinkAction' })
  readonly action!: (typeof SIGNING_LINK_ACTIONS)[number];

  @ApiProperty({ type: 'string', format: 'date-time' })
  readonly at!: string;

  @ApiProperty({ type: 'string', nullable: true, description: 'URL pública de verificación del acta (la del QR)' })
  readonly verificationUrl!: string | null;
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
  SigningLinkViewResponseDto,
  SigningLinkIdentityResponseDto,
  SigningLinkResultResponseDto,
] as const;
