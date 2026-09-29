import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiExtraModels, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Feature } from '../../common/decorators/feature.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { ApiSuccessEnvelope, envelopedSchema } from '../../common/swagger/api-envelopes.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';
import { envelopedArraySchema } from '../documents/dto/document.responses.js';
import { TRANSFER_CATALOG_MANAGE, TRANSFER_MANAGE } from './domain/transfer.js';
import {
  CancelTransferDto,
  CreateTransferDto,
  CreateTransferReasonDto,
  GenerateTransferActDto,
  QueryTransfersDto,
  UpdateTransferItemsDto,
  UpdateTransferReasonDto,
} from './dto/transfer.dto.js';
import {
  TransferDetailDto,
  TransferListResponseDto,
  TransferReasonDeletedDto,
  TransferReasonDto,
  TransferSignerCandidateDto,
} from './dto/transfer.responses.js';
import { TransferReasonsService } from './services/transfer-reasons.service.js';
import { TransferSignersService } from './services/transfer-signers.service.js';
import { TransfersService } from './services/transfers.service.js';

const READ_RULE =
  'Lectura: transfer:read:global (rol Contabilidad) o asset:read:global ven todos; asset:read:org_unit ve los traslados cuyo centro de origen o de destino está en su alcance. Fuera de alcance: 404 RESOURCE_NOT_FOUND.';

const GUARDS =
  'Guardas por activo (details trae uno por activo): RESOURCE_NOT_FOUND, TRANSFER_MIXED_SOURCE_COST_CENTER (otro centro de origen), ASSET_ALREADY_WRITTEN_OFF, ASSET_CANNOT_BE_MODIFIED (ON_LOAN), ASSET_UNDER_INVENTORY (toma física abierta), ASSET_HAS_ACTIVE_LOAN (préstamo abierto), TRANSFER_ASSET_IN_OPEN_TRANSFER, TRANSFER_REASON_UNAVAILABLE, VALIDATION_FAILED (activo repetido).';

/** Traslados de activos entre centros de costo con acta OCI-17-89 (generar = asset:update:global, su generatePermission). */
@ApiTags(OpenApiTag.Assets)
@ApiBearerAuth()
@ApiExtraModels(ApiSuccessEnvelope, TransferDetailDto, TransferListResponseDto, TransferReasonDto, TransferReasonDeletedDto, TransferSignerCandidateDto)
@Feature('assets')
@Controller('transfers')
export class TransfersController {
  constructor(
    private readonly transfers: TransfersService,
    private readonly reasons: TransferReasonsService,
    private readonly signers: TransferSignersService,
  ) {}

  // ---------- Catálogo y firmantes (antes de :id) ----------

  @Get('reasons')
  @RequirePermission(TRANSFER_MANAGE)
  @ApiOperation({ summary: 'Motivos de traslado (activos e inactivos, por sortOrder); para el formulario se usan los activos' })
  @ApiOkResponse({ schema: envelopedArraySchema(TransferReasonDto) })
  listReasons() {
    return this.reasons.list();
  }

  @Post('reasons')
  @RequirePermission(TRANSFER_CATALOG_MANAGE)
  @ApiOperation({ summary: 'Crear motivo de traslado', description: 'Errores: 409 TRANSFER_REASON_EXISTS (código repetido).' })
  @ApiCreatedResponse({ schema: envelopedSchema(TransferReasonDto) })
  createReason(@Body() dto: CreateTransferReasonDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.reasons.create(dto, actor);
  }

  @Patch('reasons/:reasonId')
  @RequirePermission(TRANSFER_CATALOG_MANAGE)
  @ApiOperation({ summary: 'Editar o (des)activar un motivo de traslado' })
  @ApiOkResponse({ schema: envelopedSchema(TransferReasonDto) })
  updateReason(
    @Param('reasonId', ParseUUIDPipe) reasonId: string,
    @Body() dto: UpdateTransferReasonDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.reasons.update(reasonId, dto, actor);
  }

  @Delete('reasons/:reasonId')
  @RequirePermission(TRANSFER_CATALOG_MANAGE)
  @ApiOperation({ summary: 'Borrar un motivo nunca usado', description: 'Con usos: 409 TRANSFER_REASON_IN_USE (se desactiva con PATCH).' })
  @ApiOkResponse({ schema: envelopedSchema(TransferReasonDeletedDto) })
  deleteReason(@Param('reasonId', ParseUUIDPipe) reasonId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.reasons.remove(reasonId, actor);
  }

  @Get('accounting-signers')
  @RequirePermission(TRANSFER_MANAGE)
  @ApiOperation({
    summary: 'Quiénes pueden firmar por Contabilidad',
    description:
      'Usuarios activos con transfer:sign_accounting:global vigente (rol CONTABILIDAD). Vacío: el acta no se puede generar (TRANSFER_NO_ACCOUNTING_SIGNER).',
  })
  @ApiOkResponse({ schema: envelopedArraySchema(TransferSignerCandidateDto) })
  accountingSigners() {
    return this.signers.candidates('ACCOUNTING');
  }

  @Get('control-signers')
  @RequirePermission(TRANSFER_MANAGE)
  @ApiOperation({
    summary: 'Quiénes pueden firmar por Control Interno',
    description:
      'Usuarios activos con el permiso vigente act:sign_control:global, «Firmar actas por Control Interno» (también son los sustitutos posibles). Vacío: TRANSFER_NO_CONTROL_SIGNER al generar. Misma lista que GET /documents/control-signers, que también la ve quien genera otras actas.',
  })
  @ApiOkResponse({ schema: envelopedArraySchema(TransferSignerCandidateDto) })
  controlSigners() {
    return this.signers.candidates('CONTROL');
  }

  // ---------- Traslados ----------

  @Get()
  @ApiOperation({ summary: 'Traslados, más recientes primero', description: READ_RULE })
  @ApiOkResponse({ schema: envelopedSchema(TransferListResponseDto) })
  list(@Query() query: QueryTransfersDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.transfers.list(query, actor);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Detalle de un traslado: activos, acta (generación y firmas) y avisos de firmantes',
    description: `${READ_RULE} Para firmar, reasignar o descargar el acta se usa /documents/:documentId.`,
  })
  @ApiOkResponse({ schema: envelopedSchema(TransferDetailDto) })
  detail(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.transfers.getById(id, actor);
  }

  @Post()
  @RequirePermission(TRANSFER_MANAGE)
  @ApiOperation({
    summary: 'Crear un traslado en DRAFT',
    description: `Activos del mismo centro de origen hacia otro centro activo que admita activos (400 TRANSFER_SAME_COST_CENTER si es el mismo). ${GUARDS} La respuesta trae controlSignerAvailable, accountingSignerAvailable y warnings.`,
  })
  @ApiCreatedResponse({ schema: envelopedSchema(TransferDetailDto) })
  create(@Body() dto: CreateTransferDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.transfers.create(dto, actor);
  }

  @Put(':id/items')
  @RequirePermission(TRANSFER_MANAGE)
  @ApiOperation({
    summary: 'Reemplazar los activos de un traslado DRAFT',
    description: `Mismo centro de origen del traslado. ${GUARDS} Fuera de DRAFT: 406 TRANSFER_INVALID_STATE_TRANSITION.`,
  })
  @ApiOkResponse({ schema: envelopedSchema(TransferDetailDto) })
  updateItems(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTransferItemsDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.transfers.updateItems(id, dto.items, actor);
  }

  @Post(':id/generate')
  @RequirePermission(TRANSFER_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Generar el acta OCI-17-89 (DRAFT → PENDING_SIGNATURES)',
    description:
      'Encola el acta en la misma transacción (outbox; document.generation dice PENDING/FAILED/GENERATED). Firmantes: ENTREGA = requester, RECIBE = owner, CONTROL_INTERNO y CONTABILIDAD = la única persona elegible o la indicada (controlSignerPersonId / accountingSignerPersonId). ' +
      'Errores: 409 TRANSFER_NO_CONTROL_SIGNER / TRANSFER_NO_ACCOUNTING_SIGNER (nadie puede firmar ese turno), 400 TRANSFER_SIGNER_REQUIRED (hay varios: indique cuál), 400 TRANSFER_SIGNER_NOT_ELIGIBLE, 409 DOCUMENT_SIGNER_DUPLICATED (una persona en dos firmas; si una es CONTROL_INTERNO, signerSubstitutions.CONTROL_INTERNO la resuelve), 400 DOCUMENT_SIGNER_SUBSTITUTE_INVALID, 409 DOCUMENT_FORMAT_NOT_READY, 406 TRANSFER_INVALID_STATE_TRANSITION, y las guardas de los activos. ' +
      'Al firmarse las cuatro firmas, cada activo pasa al centro de destino con un movimiento TRANSFER enlazado al acta y el traslado queda COMPLETED; un rechazo lo deja REJECTED sin mover activos.',
  })
  @ApiOkResponse({ schema: envelopedSchema(TransferDetailDto) })
  generate(@Param('id', ParseUUIDPipe) id: string, @Body() dto: GenerateTransferActDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.transfers.generate(id, dto, actor);
  }

  @Post(':id/cancel')
  @RequirePermission(TRANSFER_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancelar un traslado antes de cualquier firma',
    description:
      'DRAFT o PENDING_SIGNATURES sin firmas: la solicitud del acta queda CANCELLED o el acta VOIDED (con el motivo), el traslado CANCELLED y los activos libres. ' +
      'Errores: 400 VALIDATION_FAILED (motivo), 404, 406 TRANSFER_INVALID_STATE_TRANSITION (cerrado o con firmas).',
  })
  @ApiOkResponse({ schema: envelopedSchema(TransferDetailDto) })
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelTransferDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.transfers.cancel(id, dto.reason, actor);
  }
}
