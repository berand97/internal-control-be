import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiExtraModels, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Feature } from '../../common/decorators/feature.decorator.js';
import { ApiErrorEnvelope, envelopedSchema } from '../../common/swagger/api-envelopes.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';
import { envelopedArraySchema } from '../documents/dto/document.responses.js';
import { ASSET_REQUEST_EXPIRY_DAYS } from './domain/asset-request.js';
import {
  AcceptAssetRequestDto,
  AssetRequestReasonDto,
  CorrectAssetRequestDto,
  CreateAssetRequestDto,
  EligibleAssetsQueryDto,
  GenerateAssetRequestDto,
  OwnerAvailabilityQueryDto,
  QueryAssetRequestsDto,
  ResolveScanDto,
} from './dto/asset-request.dto.js';
import {
  ASSET_REQUEST_RESPONSE_MODELS,
  AssetRequestCentersDto,
  AssetRequestDetailDto,
  AssetRequestListResponseDto,
  EligibleAssetDto,
  OwnerAvailabilityDto,
  ResolvedScanDto,
} from './dto/asset-request.responses.js';
import { AssetRequestsService } from './services/asset-requests.service.js';

const PARTIES =
  'Solo la ven sus partes: quien la solicitó, los jefes vigentes del centro dueño y Control Interno (asset_request:review:global). Cualquier otro usuario: 404 RESOURCE_NOT_FOUND, igual que una solicitud inexistente.';

const OWNER_ONLY =
  'Solo un jefe vigente del centro dueño que no sea quien solicitó; cualquier otro caso (otra solicitud, otro centro, token inválido, activo de otro centro) responde 404 RESOURCE_NOT_FOUND sin datos.';

// Sin @RequirePermission: quién puede cada acción depende de la jefatura vigente sobre los centros de la solicitud,
// que el guard no conoce; lo decide el servicio.
@ApiTags(OpenApiTag.Loans)
@ApiBearerAuth()
@ApiExtraModels(ApiErrorEnvelope, ...ASSET_REQUEST_RESPONSE_MODELS)
@Feature('loans')
@Controller('asset-requests')
export class AssetRequestsController {
  constructor(private readonly requests: AssetRequestsService) {}

  @Get('centers')
  @ApiOperation({
    summary: 'Centros para crear o corregir una solicitud',
    description:
      'Cualquier usuario autenticado, sin cost_center:read:global. headed: centros activos que el usuario dirige hoy (desde ellos solicita); ' +
      'owners: centros activos que aceptan activos (a ellos pide). Solo id, código y nombre: ni jefes, ni conteos, ni activos.',
  })
  @ApiOkResponse({ schema: envelopedSchema(AssetRequestCentersDto) })
  centers(@CurrentUser() actor: AuthenticatedUser) {
    return this.requests.centers(actor);
  }

  @Get('owner-availability')
  @ApiOperation({
    summary: '¿El centro dueño tiene jefe vigente que decida?',
    description:
      'Para avisar antes de enviar la solicitud. Solo dice si hay jefe (sin nombres: Ley 1581). No cuenta a quien consulta.',
  })
  @ApiOkResponse({ schema: envelopedSchema(OwnerAvailabilityDto) })
  ownerAvailability(@Query() query: OwnerAvailabilityQueryDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.requests.ownerAvailability(query.costCenterId, actor);
  }

  @Get()
  @ApiOperation({
    summary: 'Bandejas de solicitudes de activos',
    description:
      'box=mine: las que abrí; box=to-decide: las de los centros que dirijo hoy; box=review: todas (403 INSUFFICIENT_PERMISSIONS sin asset_request:review:global).',
  })
  @ApiOkResponse({ schema: envelopedSchema(AssetRequestListResponseDto) })
  list(@Query() query: QueryAssetRequestsDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.requests.list(query, actor);
  }

  @Post()
  @ApiOperation({
    summary: 'Solicitar activos a otro centro de costo',
    description:
      'Quien solicita debe ser jefe vigente de requestingCostCenterId (si no, 403 ASSET_REQUEST_NOT_HEAD). El centro dueño debe tener jefe vigente distinto de quien solicita ' +
      '(si no, 409 ASSET_REQUEST_OWNER_WITHOUT_HEAD). TEMPORARY exige startDate y expectedReturnDate. note es texto libre que nunca se resuelve contra activos. ' +
      'Avisa a los jefes del centro dueño.',
  })
  @ApiCreatedResponse({ schema: envelopedSchema(AssetRequestDetailDto) })
  create(@Body() dto: CreateAssetRequestDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.requests.create(dto, actor);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle de una solicitud con sus activos elegidos, su documento y su historial', description: PARTIES })
  @ApiOkResponse({ schema: envelopedSchema(AssetRequestDetailDto) })
  getById(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.requests.getById(id, actor);
  }

  @Get(':id/eligible-assets')
  @ApiOperation({
    summary: 'Activos del centro dueño que se pueden elegir',
    description: `IN_USE o IN_STORAGE, sin préstamo, traslado, toma física ni otra solicitud abiertos. ${OWNER_ONLY}`,
  })
  @ApiOkResponse({ schema: envelopedArraySchema(EligibleAssetDto) })
  eligibleAssets(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: EligibleAssetsQueryDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.requests.eligibleAssets(id, query, actor);
  }

  @Post(':id/resolve-scan')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resolver el QR de una etiqueta para elegir el activo', description: OWNER_ONLY })
  @ApiOkResponse({ schema: envelopedSchema(ResolvedScanDto) })
  resolveScan(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ResolveScanDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.requests.resolveScan(id, dto.token, actor);
  }

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'El jefe dueño acepta y elige los activos',
    description:
      `REQUESTED → ACCEPTED. Jefe vigente del centro dueño (403 ASSET_REQUEST_NOT_HEAD); no quien solicitó (403 ASSET_REQUEST_SOD_VIOLATION). ` +
      `Todos los activos del centro dueño (si no, 404 como inexistentes) y elegibles (406 ASSET_REQUEST_ASSET_UNAVAILABLE con el motivo por activo). ` +
      `Quedan reservados; si Control Interno no resuelve en ${ASSET_REQUEST_EXPIRY_DAYS} días, la solicitud vence. Avisa al solicitante y a Control Interno.`,
  })
  @ApiOkResponse({ schema: envelopedSchema(AssetRequestDetailDto) })
  accept(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AcceptAssetRequestDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.requests.accept(id, dto, actor);
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'El jefe dueño cierra la solicitud (es un no)',
    description: 'REQUESTED → CLOSED_BY_OWNER, final. Motivo obligatorio. Mismas reglas de jefatura y separación que aceptar.',
  })
  @ApiOkResponse({ schema: envelopedSchema(AssetRequestDetailDto) })
  close(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AssetRequestReasonDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.requests.close(id, dto.reason, actor);
  }

  @Post(':id/return')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Control Interno devuelve la solicitud al solicitante para corregir',
    description: 'ACCEPTED → RETURNED. Motivo obligatorio. Requiere asset_request:review:global. Los activos siguen reservados.',
  })
  @ApiOkResponse({ schema: envelopedSchema(AssetRequestDetailDto) })
  returnToRequester(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssetRequestReasonDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.requests.returnToRequester(id, dto.reason, actor);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'El solicitante corrige una solicitud devuelta',
    description:
      'Solo RETURNED y solo quien la solicitó. Si cambia tipo, centro que solicita o centro dueño vuelve al dueño (REQUESTED, se descartan los activos elegidos); ' +
      'si solo cambia descripción, nota o fechas vuelve a Control Interno (ACCEPTED, con los mismos activos y un nuevo plazo).',
  })
  @ApiOkResponse({ schema: envelopedSchema(AssetRequestDetailDto) })
  correct(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CorrectAssetRequestDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.requests.correct(id, dto, actor);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'El solicitante cancela',
    description: 'REQUESTED o RETURNED → CANCELLED, final. Motivo obligatorio. Libera los activos reservados.',
  })
  @ApiOkResponse({ schema: envelopedSchema(AssetRequestDetailDto) })
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AssetRequestReasonDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.requests.cancel(id, dto.reason, actor);
  }

  @Post(':id/generate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Control Interno genera el préstamo o el traslado con su acta',
    description:
      'ACCEPTED → DOCUMENT_GENERATED en una transacción. Requiere asset_request:review:global y el permiso de generación del formato (OCI-01-65: loan:update:global; OCI-17-89: asset:update:global). ' +
      'TEMPORARY: préstamo APPROVED (aprobó el jefe dueño al aceptar) y entregado: activos ON_LOAN y acta OCI-01-65 con ENTREGA = jefe dueño que aceptó, RECIBE = solicitante, AUDITA = Control Interno. ' +
      'PERMANENT: traslado con items (datos del acta por activo, exactamente los aceptados) y acta OCI-17-89 con ENTREGA = jefe dueño, RECIBE = solicitante, CONTROL_INTERNO y CONTABILIDAD por rol ' +
      '(TRANSFER_NO_CONTROL_SIGNER / TRANSFER_NO_ACCOUNTING_SIGNER / TRANSFER_SIGNER_REQUIRED si faltan o hay varios). Se aplican las guardas del préstamo o del traslado. ' +
      'Cuando el acta queda firmada, el solicitante y los jefes del centro dueño reciben el enlace.',
  })
  @ApiOkResponse({ schema: envelopedSchema(AssetRequestDetailDto) })
  generate(@Param('id', ParseUUIDPipe) id: string, @Body() dto: GenerateAssetRequestDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.requests.generate(id, dto, actor);
  }
}
