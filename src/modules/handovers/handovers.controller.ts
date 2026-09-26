import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Feature } from '../../common/decorators/feature.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { ApiSuccessEnvelope, envelopedSchema } from '../../common/swagger/api-envelopes.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';
import {
  CancelHandoverDto,
  CreateHandoverDto,
  HandoverDetailDto,
  HandoverListResponseDto,
  QueryHandoversDto,
} from './dto/handover.dto.js';
import { HandoversService } from './services/handovers.service.js';

/** Permisos del formato OCI-01-55 (document-formats.ts): generar = asset:update:global, leer = asset:read:global. */
@ApiTags(OpenApiTag.Assets)
@ApiBearerAuth()
@ApiExtraModels(ApiSuccessEnvelope, HandoverDetailDto, HandoverListResponseDto)
@Feature('assets')
@Controller('handovers')
export class HandoversController {
  constructor(private readonly handovers: HandoversService) {}

  @Post()
  @RequirePermission('asset:update:global')
  @ApiOperation({
    summary: 'Crear una entrega de activos y encolar su acta OCI-01-55',
    description:
      'La entrega y la solicitud del acta se guardan juntas; el acta se genera después (outbox). document.generation dice si está pendiente, fallida (lastError, se reintenta con POST /documents/requests/:requestId/retry) o generada. Al firmarse el acta (RECIBE y luego AUDITA) cada activo queda con el firmante RECIBE final como responsable. Errores: RESOURCE_NOT_FOUND (activo, persona o centro inexistente), VALIDATION_FAILED (activo repetido), HANDOVER_ASSET_NOT_DELIVERABLE (activo WRITTEN_OFF u ON_LOAN), HANDOVER_COST_CENTER_MISMATCH (el activo está en otro centro de costo), HANDOVER_ASSET_IN_OPEN_HANDOVER (el activo ya está en otra entrega abierta). details trae un elemento por activo.',
  })
  @ApiCreatedResponse({ schema: envelopedSchema(HandoverDetailDto) })
  create(@Body() dto: CreateHandoverDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.handovers.create(dto, actor);
  }

  @Post(':id/cancel')
  @RequirePermission('asset:update:global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancelar una entrega antes de que su acta quede firmada',
    description:
      'En una transacción: la solicitud del acta queda CANCELLED o el acta PENDING_SIGNATURE queda VOIDED (con el motivo; nadie puede firmarla), la entrega queda CANCELLED y sus activos se liberan sin cambios. ' +
      'Regla provisional (pendiente de Control Interno): permiso de generación del OCI-01-55 (asset:update:global) y solo antes de SIGNED. ' +
      'Errores: 400 VALIDATION_FAILED (motivo), 404 RESOURCE_NOT_FOUND, 409 DOCUMENT_ALREADY_SIGNED (ya firmada), 406 INVALID_STATE (REJECTED o CANCELLED).',
  })
  @ApiOkResponse({ schema: envelopedSchema(HandoverDetailDto) })
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelHandoverDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.handovers.cancel(id, dto.reason, actor);
  }

  @Get()
  @RequirePermission('asset:read:global')
  @ApiOperation({ summary: 'Entregas de activos, más recientes primero, con el estado de generación de su acta' })
  @ApiOkResponse({ schema: envelopedSchema(HandoverListResponseDto) })
  list(@Query() query: QueryHandoversDto) {
    return this.handovers.list({
      page: query.page,
      pageSize: query.pageSize,
      ...(query.status ? { status: query.status } : {}),
    });
  }

  @Get(':id')
  @RequirePermission('asset:read:global')
  @ApiOperation({
    summary: 'Detalle de una entrega: activos, acta, estado de generación y de firma',
    description: 'Para firmar, reasignar un turno o descargar el acta se usa /documents/:documentId.',
  })
  @ApiOkResponse({ schema: envelopedSchema(HandoverDetailDto) })
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.handovers.detail(id);
  }
}
