import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiExtraModels, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Feature } from '../../common/decorators/feature.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { ApiSuccessEnvelope, envelopedSchema } from '../../common/swagger/api-envelopes.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';
import { ControlSignerDto, envelopedArraySchema } from '../documents/dto/document.responses.js';
import { WRITE_OFF_MANAGE } from './domain/write-off.js';
import { CancelWriteOffDto, CreateWriteOffDto, GenerateWriteOffActDto, QueryWriteOffsDto, UpdateWriteOffDto } from './dto/write-off.dto.js';
import { WriteOffDetailDto, WriteOffItemStateOptionDto, WriteOffListResponseDto } from './dto/write-off.responses.js';
import { WriteOffsService } from './services/write-offs.service.js';

const READ_RULE =
  'Lectura: asset:write_off:global o asset:read:global ven todas. asset:read:org_unit ve las bajas con algún activo de los centros de su alcance. Fuera de alcance: 404 RESOURCE_NOT_FOUND.';

const GUARDS =
  'Los activos pueden ser de varios centros de costo. Cada fila guarda el centro del activo al agregarlo. Guardas por activo (details trae uno por activo): RESOURCE_NOT_FOUND, WRITE_OFF_ASSET_HELD (dado de baja, prestado, en préstamo, traslado, entrega, solicitud, toma física u otra baja abiertos), VALIDATION_FAILED (activo repetido).';

@ApiTags(OpenApiTag.Assets)
@ApiBearerAuth()
@ApiExtraModels(ApiSuccessEnvelope, WriteOffDetailDto, WriteOffListResponseDto, WriteOffItemStateOptionDto, ControlSignerDto)
@Feature('assets')
@Controller('write-offs')
export class WriteOffsController {
  constructor(private readonly writeOffs: WriteOffsService) {}

  @Get('item-states')
  @RequirePermission(WRITE_OFF_MANAGE)
  @ApiOperation({ summary: 'Estados del activo para la columna Estado del acta OCI-17-90' })
  @ApiOkResponse({ schema: envelopedArraySchema(WriteOffItemStateOptionDto) })
  itemStates() {
    return this.writeOffs.itemStates();
  }

  @Get('accounting-signers')
  @RequirePermission(WRITE_OFF_MANAGE)
  @ApiOperation({
    summary: 'Quiénes pueden firmar por Contabilidad',
    description: 'Usuarios activos con transfer:sign_accounting:global vigente (rol CONTABILIDAD). Vacío: WRITE_OFF_NO_ACCOUNTING_SIGNER al generar.',
  })
  @ApiOkResponse({ schema: envelopedArraySchema(ControlSignerDto) })
  accountingSigners() {
    return this.writeOffs.accountingSigners();
  }

  @Get()
  @ApiOperation({ summary: 'Bajas de activos, más recientes primero', description: READ_RULE })
  @ApiOkResponse({ schema: envelopedSchema(WriteOffListResponseDto) })
  list(@Query() query: QueryWriteOffsDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.writeOffs.list(query, actor);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Detalle de una baja: datos, activos y acta (generación y firmas)',
    description: `${READ_RULE} Para firmar, rechazar o descargar el acta se usa /documents/:documentId.`,
  })
  @ApiOkResponse({ schema: envelopedSchema(WriteOffDetailDto) })
  detail(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.writeOffs.getById(id, actor);
  }

  @Post()
  @RequirePermission(WRITE_OFF_MANAGE)
  @ApiOperation({
    summary: 'Crear una baja en DRAFT',
    description: `Cada activo lleva cantidad (por defecto 1), estado y observaciones. authorizedTotal, councilAgreementNumber, councilAgreementDate y vicefinanceReports van al pie del acta. ${GUARDS}`,
  })
  @ApiCreatedResponse({ schema: envelopedSchema(WriteOffDetailDto) })
  create(@Body() dto: CreateWriteOffDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.writeOffs.create(dto, actor);
  }

  @Patch(':id')
  @RequirePermission(WRITE_OFF_MANAGE)
  @ApiOperation({
    summary: 'Editar una baja DRAFT',
    description: `Campos omitidos no cambian. items reemplaza la lista. ${GUARDS} Fuera de DRAFT: 406 WRITE_OFF_INVALID_STATE_TRANSITION.`,
  })
  @ApiOkResponse({ schema: envelopedSchema(WriteOffDetailDto) })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateWriteOffDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.writeOffs.update(id, dto, actor);
  }

  @Post(':id/generate')
  @RequirePermission(WRITE_OFF_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Generar el acta de baja OCI-17-90 (DRAFT → PENDING_SIGNATURES)',
    description:
      'Encola el acta en la misma transacción (outbox). Los firmantes y su orden salen de la versión vigente del formato: CONTROL_INTERNO (única persona elegible o controlSignerPersonId) y CONTABILIDAD (única persona elegible o accountingSignerPersonId). ' +
      'Errores: 400 VALIDATION_FAILED sin authorizedTotal, 409 WRITE_OFF_NO_CONTROL_SIGNER o WRITE_OFF_NO_ACCOUNTING_SIGNER, 400 WRITE_OFF_SIGNER_REQUIRED (hay varias personas), 400 WRITE_OFF_SIGNER_NOT_ELIGIBLE, 409 DOCUMENT_SIGNER_DUPLICATED, 409 DOCUMENT_FORMAT_NOT_READY, 406 WRITE_OFF_INVALID_STATE_TRANSITION y las guardas de los activos. ' +
      'Con todas las firmas, cada activo queda WRITTEN_OFF con un movimiento WRITE_OFF enlazado al acta y la baja COMPLETED. Un rechazo la deja REJECTED sin tocar los activos y los libera.',
  })
  @ApiOkResponse({ schema: envelopedSchema(WriteOffDetailDto) })
  generate(@Param('id', ParseUUIDPipe) id: string, @Body() dto: GenerateWriteOffActDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.writeOffs.generate(id, dto, actor);
  }

  @Post(':id/cancel')
  @RequirePermission(WRITE_OFF_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancelar una baja antes de cualquier firma',
    description:
      'DRAFT o PENDING_SIGNATURES sin firmas: la solicitud del acta queda CANCELLED o el acta VOIDED, la baja CANCELLED y los activos libres. Errores: 400 VALIDATION_FAILED, 404, 406 WRITE_OFF_INVALID_STATE_TRANSITION.',
  })
  @ApiOkResponse({ schema: envelopedSchema(WriteOffDetailDto) })
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelWriteOffDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.writeOffs.cancel(id, dto.reason, actor);
  }
}
