import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Ip,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { SGC_VERSION_PATTERN } from './domain/document-formats.js';
import type { Response } from 'express';
import { ErrorCode } from '../../common/constants/error-code.enum.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Feature } from '../../common/decorators/feature.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { ApiException } from '../../common/exceptions/api.exception.js';
import { BoundedFileInterceptor, UPLOAD_LIMITS } from '../../shared/storage/uploads/bounded-file.interceptor.js';
import { assertZipWithinLimits, ZIP_LIMITS } from '../../shared/storage/uploads/zip-limits.js';
import { envelopedSchema } from '../../common/swagger/api-envelopes.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';
import {
  DOCUMENT_RESPONSE_MODELS,
  ControlSignerDto,
  DocumentDetailResponseDto,
  DocumentFormatResponseDto,
  DocumentFormatVersionResponseDto,
  DocumentListItemDto,
  DocumentListResponseDto,
  envelopedArraySchema,
  GeneratedDocumentResponseDto,
  UploadedTemplateResponseDto,
} from './dto/document.responses.js';
import { CreateDocumentFormatDto, DocumentFormatVersionInputDto } from './dto/document-format.dto.js';
import type { SignerSubstitutionsInput } from './dto/signer-substitution.dto.js';
import { DocumentLifecycleRegistry } from './lifecycle/document-lifecycle.registry.js';
import { ControlSignersService } from './services/control-signers.service.js';
import { DocumentFormatCatalogService } from './services/document-format-catalog.service.js';
import { DocumentEngineService } from './services/document-engine.service.js';
import { DOCUMENT_LIST_STATUSES, DocumentListService, type DocumentListStatus } from './services/document-list.service.js';

export class GenerateDocumentDto {
  @IsString()
  readonly formatKey!: string;

  @IsOptional()
  @IsString()
  readonly entityType?: string;

  @IsOptional()
  @IsUUID()
  readonly entityId?: string;

  @IsOptional()
  @IsUUID()
  readonly costCenterId?: string;

  @IsOptional()
  @IsUUID()
  readonly responsiblePersonId?: string;

  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  readonly assetIds?: string[];

  @IsOptional()
  @IsObject()
  readonly movementIds?: Record<string, string>;

  @IsOptional()
  @IsObject()
  readonly signers?: Record<string, string>;

  @IsOptional()
  @IsObject()
  readonly assetNotes?: Record<string, string>;

  @IsOptional()
  @IsObject()
  readonly fields?: Record<string, string>;

  /** Sustitutos de turnos de Control Interno (separación de funciones); el motor valida la forma. */
  @IsOptional()
  @IsObject()
  readonly signerSubstitutions?: SignerSubstitutionsInput;
}

export class SignDocumentDto {
  @IsString()
  @MaxLength(90_000)
  readonly rubric!: string;
}

export class ReassignSignerDto {
  @IsUUID()
  readonly personId!: string;

  @IsString()
  @MinLength(5)
  @MaxLength(500)
  readonly reason!: string;
}

export class RejectSignatureDto {
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  readonly reason!: string;
}

export class QueryDocumentsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  readonly page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  readonly pageSize: number = 20;

  @IsOptional()
  @IsString()
  readonly formatKey?: string;

  @IsOptional()
  @IsIn(DOCUMENT_LIST_STATUSES)
  readonly status?: DocumentListStatus;

  @IsOptional()
  @IsDateString()
  readonly from?: string;

  @IsOptional()
  @IsDateString()
  readonly to?: string;
}

export class UploadTemplateDto {
  /** Versión SGC impresa en formato.version. Por defecto, la de la versión del formato que regirá con la plantilla. */
  @IsOptional()
  @IsString()
  @MaxLength(10)
  @Matches(SGC_VERSION_PATTERN, {
    message: 'sgcVersion admite de 1 a 10 letras, dígitos, punto, guion o guion bajo, sin "/" ni ".."',
  })
  readonly sgcVersion?: string;

  @IsDateString()
  readonly effectiveDate!: string;
}

interface DocxUpload {
  readonly originalname: string;
  readonly buffer: Buffer;
  readonly size: number;
}

@ApiTags(OpenApiTag.DocumentTemplates)
@ApiBearerAuth()
@ApiExtraModels(...DOCUMENT_RESPONSE_MODELS)
@Feature('document-templates')
@Controller('documents')
export class DocumentsController {
  constructor(
    private readonly engine: DocumentEngineService,
    private readonly documentList: DocumentListService,
    private readonly lifecycle: DocumentLifecycleRegistry,
    private readonly catalog: DocumentFormatCatalogService,
    private readonly controlSigners: ControlSignersService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Documentos generados y solicitudes pendientes o fallidas',
    description:
      'Solo los formatos que el usuario puede leer. Orden: más recientes primero, con id como desempate. Una solicitud FAILED trae su error y se reintenta con POST /documents/requests/:requestId/retry.',
  })
  @ApiOkResponse({ schema: envelopedSchema(DocumentListResponseDto) })
  list(@Query() query: QueryDocumentsDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.documentList.list(
      {
        page: query.page,
        pageSize: query.pageSize,
        ...(query.formatKey ? { formatKey: query.formatKey } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.from ? { from: query.from.slice(0, 10) } : {}),
        ...(query.to ? { to: query.to.slice(0, 10) } : {}),
      },
      actor.id,
    );
  }

  @Post('requests/:requestId/retry')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Reencolar una solicitud fallida',
    description: 'Solo la devuelve al outbox (PENDING); el job la genera en su siguiente pasada. Requiere el permiso de generación del formato.',
  })
  @ApiOkResponse({ schema: envelopedSchema(DocumentListItemDto) })
  retry(@Param('requestId', ParseUUIDPipe) requestId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.documentList.retry(requestId, actor.id);
  }

  @Get('formats')
  @RequirePermission('document_template:read:global')
  @ApiOperation({
    summary: 'Formatos SGC: versión vigente, plantilla vigente y último consecutivo',
    description:
      'Cada formato con su versión vigente hoy (versionId, versionNumber, effectiveFrom), la próxima programada (scheduledVersion) y el proceso de negocio enchufado en código (process). Orden: código SGC, sin código al final.',
  })
  @ApiOkResponse({ schema: envelopedArraySchema(DocumentFormatResponseDto) })
  formats() {
    return this.engine.formats();
  }

  @Post('formats')
  @RequirePermission('document_template:update:global')
  @ApiOperation({
    summary: 'Crear un formato SGC con su primera versión',
    description:
      'Queda generable de inmediato con POST /documents (subida la plantilla). Conectarlo a un proceso de negocio es desarrollo, no se hace aquí. ' +
      'Errores: 409 DOCUMENT_FORMAT_ALREADY_EXISTS (clave usada), 400 VALIDATION_FAILED (campos, permisos inexistentes), ' +
      '409 DOCUMENT_FORMAT_SEQUENCE_STARTED (ya hay consecutivo con esa clave y el valor inicial no aplicaría).',
  })
  @ApiCreatedResponse({ schema: envelopedSchema(DocumentFormatResponseDto) })
  async createFormat(@Body() dto: CreateDocumentFormatDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.engine.formatSummary(await this.catalog.createFormat(dto, actor.id));
  }

  @Get('formats/:formatKey/versions')
  @RequirePermission('document_template:read:global')
  @ApiOperation({
    summary: 'Historial de versiones de un formato, la más reciente primero',
    description: 'status: CURRENT (la usa la próxima acta), SCHEDULED (vigencia futura), SUPERSEDED. documentCount: actas emitidas con cada versión.',
  })
  @ApiOkResponse({ schema: envelopedArraySchema(DocumentFormatVersionResponseDto) })
  versions(@Param('formatKey') formatKey: string) {
    return this.catalog.history(formatKey);
  }

  @Post('formats/:formatKey/versions')
  @RequirePermission('document_template:update:global')
  @ApiOperation({
    summary: 'Crear una versión nueva de un formato (código y versión SGC, nombre, firmantes, numeración)',
    description:
      'Instantánea completa: lo que no se envía no se hereda. Nunca modifica una versión existente: las actas ya emitidas conservan la suya ' +
      '(firmantes, etiquetas, hoja de firmas y verificación pública). Rige desde effectiveFrom (hoy por defecto). ' +
      'Errores: 404 formato inexistente; 400 VALIDATION_FAILED; 409 DOCUMENT_FORMAT_BREAKS_PROCESS (quita, añade o cambia el origen de un rol ' +
      'que el proceso enchufado necesita; ver process.requiredSigners en GET /documents/formats); 409 DOCUMENT_FORMAT_SEQUENCE_STARTED ' +
      '(cambia el valor inicial de un consecutivo que ya empezó).',
  })
  @ApiCreatedResponse({ schema: envelopedSchema(DocumentFormatVersionResponseDto) })
  async createVersion(
    @Param('formatKey') formatKey: string,
    @Body() dto: DocumentFormatVersionInputDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const created = await this.catalog.createVersion(formatKey, dto, actor.id);
    const history = await this.catalog.history(formatKey);
    return history.find((item) => item.versionId === created.versionId);
  }

  @Post('formats/:formatKey/templates')
  @RequirePermission('document_template:update:global')
  @UseInterceptors(BoundedFileInterceptor('file', UPLOAD_LIMITS.DOCX_TEMPLATE))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Subir una versión de plantilla DOCX con su fecha de vigencia',
    description:
      'Se registra con el código SGC de la versión del formato que regirá cuando la plantilla empiece a usarse. sgcVersion es opcional (1 a 10 letras, dígitos, punto, guion o guion bajo; sin "/" ni "..": si no, 400 VALIDATION_FAILED): por defecto, la versión SGC de esa versión del formato. 409 DOCUMENT_FORMAT_NOT_READY si esa versión no tiene código SGC.' })
  @ApiCreatedResponse({ schema: envelopedSchema(UploadedTemplateResponseDto) })
  uploadTemplate(
    @Param('formatKey') formatKey: string,
    @UploadedFile() file: DocxUpload | undefined,
    @Body() dto: UploadTemplateDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    if (!file || !file.originalname.toLowerCase().endsWith('.docx')) {
      throw new ApiException(ErrorCode.FileTypeNotAllowed, 'Se espera un archivo .docx');
    }
    assertZipWithinLimits(file.buffer, ZIP_LIMITS.DOCX);
    return this.engine.uploadTemplate(formatKey, file, { ...(dto.sgcVersion ? { sgcVersion: dto.sgcVersion } : {}), effectiveDate: dto.effectiveDate.slice(0, 10) }, actor.id);
  }

  @Post()
  @ApiOperation({
    summary: 'Generar un documento (DOCX y PDF) que queda pendiente de firma',
    description:
      'Un entityType con proceso registrado (DocumentLifecycleRegistry) está reservado a ese proceso: su acta solo la genera el proceso, nunca este endpoint.',
  })
  @ApiCreatedResponse({ schema: envelopedSchema(GeneratedDocumentResponseDto) })
  generate(@Body() dto: GenerateDocumentDto, @CurrentUser() actor: AuthenticatedUser) {
    if (this.lifecycle.has(dto.entityType)) {
      throw new ApiException(ErrorCode.ValidationFailed, `El acta de ${dto.entityType} la genera su propio proceso`);
    }
    return this.engine.generate(dto, actor.id);
  }

  // Antes de ':id': si no, la ruta la toma el detalle y ParseUUIDPipe responde 400.
  @Get('control-signers')
  @ApiOperation({
    summary: 'Quiénes pueden firmar por Control Interno',
    description:
      'Personas activas con usuario ACTIVE y el permiso vigente act:sign_control:global («Firmar actas por Control Interno»), para elegir el firmante al generar un acta ' +
      '(controlSignerPersonId, controlInternoPersonId). Requiere cualquier permiso de generación de un formato vigente del catálogo (asset:update:global, loan:update:global, inventory:execute:global, …) ' +
      'o asset_request:review:global; sin ninguno, 403 INSUFFICIENT_PERMISSIONS. Es la misma lista con la que se valida al generar: vacía, TRANSFER_NO_CONTROL_SIGNER; ' +
      'varias personas sin elegir, TRANSFER_SIGNER_REQUIRED; una persona fuera de ella, TRANSFER_SIGNER_NOT_ELIGIBLE.',
  })
  @ApiOkResponse({ schema: envelopedArraySchema(ControlSignerDto) })
  controlSignerList(@CurrentUser() actor: AuthenticatedUser) {
    return this.controlSigners.forGenerator(actor.id);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Estado del documento y de sus firmas',
    description:
      'currentTurn dice de quién es el turno. viewer dice si el usuario firma en este documento, si es su turno, si puede firmar ya (canSign) y, si no, el código de error que recibiría (blockedBy). reassignments es la bitácora de reasignaciones.',
  })
  @ApiOkResponse({ schema: envelopedSchema(DocumentDetailResponseDto) })
  detail(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.engine.detail(id, actor);
  }

  @Post(':id/signatures/sync')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Consultar al proveedor de firma y actualizar el estado',
    description:
      'Si el acta tiene todas las firmas (o una rechazada) y el proceso que la originó falló al aplicar sus efectos (lifecycleError), reintenta la transición.',
  })
  @ApiOkResponse({ schema: envelopedSchema(DocumentDetailResponseDto) })
  async sync(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.engine.detail(id, actor);
    await this.engine.syncSignatures(id);
    return this.engine.detail(id, actor);
  }

  @Post(':id/signatures/:order/reassign')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Reasignar un turno de firma pendiente',
    description:
      'Solo quien administra el proceso (permiso de generación del formato). Queda como evidencia: quién, cuándo, desde dónde, de quién a quién y por qué.',
  })
  @ApiOkResponse({ schema: envelopedSchema(DocumentDetailResponseDto) })
  reassign(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('order', ParseIntPipe) order: number,
    @Body() dto: ReassignSignerDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string | undefined,
  ) {
    return this.engine.reassignSigner(id, order, dto.personId, dto.reason, actor, {
      ipAddress: ipAddress || null,
      userAgent: userAgent ?? null,
    });
  }

  @Post(':id/signatures/:order/signing-link')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Reenviar el enlace de firma por correo del turno actual',
    description:
      'Solo quien administra el proceso (permiso de generación del formato) y solo para el turno actual de una persona sin usuario activo. Invalida el enlace anterior (RESENT) y encola uno nuevo; el correo sale fuera de la transacción y su resultado se ve en signatures[].signingLink. Errores: SIGNATURE_LINK_NOT_APPLICABLE (no es el turno actual o la persona firma con sesión), SIGNATURE_NO_CHANNEL, SIGNATURE_NO_IDENTITY_CHECK, SIGNATURE_SIGNER_INACTIVE, SIGNATURE_SIGNER_UNASSIGNED.',
  })
  @ApiOkResponse({ schema: envelopedSchema(DocumentDetailResponseDto) })
  resendSigningLink(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('order', ParseIntPipe) order: number,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.engine.resendSigningLink(id, order, actor);
  }

  @Post(':id/signatures/:order')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Firmar mi turno con la rúbrica dibujada',
    description:
      'Solo la persona designada para ese turno, con sesión vigente; en los turnos de Control Interno (AUDITA, CONTROL_INTERNO) además con MFA activo (SIGNATURE_MFA_REQUIRED). rubric es un PNG en data URL o base64. Se registra quién, cuándo, desde qué IP, bajo qué sesión y con qué método (SESSION_MFA o SESSION), y el hash del PDF antes y después.',
  })
  @ApiOkResponse({ schema: envelopedSchema(DocumentDetailResponseDto) })
  sign(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('order', ParseIntPipe) order: number,
    @Body() dto: SignDocumentDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string | undefined,
  ) {
    const rubric = Buffer.from(dto.rubric.replace(/^data:image\/png;base64,/, ''), 'base64');
    return this.engine.sign(id, order, actor, rubric, { ipAddress: ipAddress || null, userAgent: userAgent ?? null });
  }

  @Post(':id/signatures/:order/reject')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rechazar la firma de mi turno, con motivo' })
  @ApiOkResponse({ schema: envelopedSchema(DocumentDetailResponseDto) })
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('order', ParseIntPipe) order: number,
    @Body() dto: RejectSignatureDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string | undefined,
  ) {
    return this.engine.rejectSignature(id, order, actor, dto.reason, {
      ipAddress: ipAddress || null,
      userAgent: userAgent ?? null,
    });
  }

  @Get(':id/pdf')
  @ApiOperation({ summary: 'Descargar el PDF, con el permiso de lectura del proceso' })
  async pdf(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthenticatedUser, @Res() response: Response) {
    const file = await this.engine.download(id, 'pdf', actor.id);
    response.setHeader('Content-Type', file.contentType);
    response.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    response.send(file.body);
  }

  @Get(':id/docx')
  @ApiOperation({ summary: 'Descargar el DOCX, con el permiso de lectura del proceso' })
  async docx(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthenticatedUser, @Res() response: Response) {
    const file = await this.engine.download(id, 'docx', actor.id);
    response.setHeader('Content-Type', file.contentType);
    response.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    response.send(file.body);
  }
}
