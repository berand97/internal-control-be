import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
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
import { ApiErrorEnvelope, ApiSuccessEnvelope, envelopedSchema } from '../../common/swagger/api-envelopes.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';
import { envelopedArraySchema } from '../documents/dto/document.responses.js';
import type { ReadableCostCenterScope } from '../roles/services/cost-center-scope.js';
import { AssetReadCatalog, AssetReadScope, AssetReadScopeGuard } from './asset-read-scope.guard.js';
import {
  CreatePriceZeroReasonDto,
  QueryPriceZeroAssetsDto,
  SetPriceZeroReasonDto,
  UpdatePriceZeroReasonDto,
} from './dto/price-zero.dto.js';
import {
  PriceZeroAssetDto,
  PriceZeroAssetListDto,
  PriceZeroReasonDeletedDto,
  PriceZeroReasonDto,
} from './dto/responses/price-zero.response.dto.js';
import { AssetPriceZeroService } from './services/asset-price-zero.service.js';

const MANAGE = 'asset_price_zero_reason:manage:global';

const READ_SCOPE =
  'Requiere asset:read:global (todos los activos) o asset:read:org_unit (solo los de sus centros de costo); fuera de ' +
  'alcance responde como inexistente.';

/**
 * Activos con precio de compra cero: catálogo de motivos (nace vacío) y lista de trabajo para clasificarlos. Registrado
 * antes que AssetsController para que /assets/price-zero no caiga en GET /assets/:id.
 */
@ApiTags(OpenApiTag.Assets)
@ApiBearerAuth()
@ApiExtraModels(ApiSuccessEnvelope, ApiErrorEnvelope, PriceZeroReasonDto, PriceZeroReasonDeletedDto, PriceZeroAssetDto, PriceZeroAssetListDto)
@Feature('assets')
@Controller('assets')
export class AssetPriceZeroController {
  constructor(private readonly priceZero: AssetPriceZeroService) {}

  @Get('price-zero-reasons')
  @UseGuards(AssetReadScopeGuard)
  @AssetReadCatalog()
  @ApiOperation({
    summary: 'Motivos de precio de compra cero',
    description: 'Todos, activos o no. Nace vacío: Control Interno lo llena. Basta un permiso de lectura de activos.',
  })
  @ApiOkResponse({ schema: envelopedArraySchema(PriceZeroReasonDto) })
  listReasons() {
    return this.priceZero.listReasons();
  }

  @Post('price-zero-reasons')
  @RequirePermission(MANAGE)
  @ApiOperation({ summary: 'Crear motivo de precio cero', description: 'El nombre no se repite (sin distinguir mayúsculas).' })
  @ApiCreatedResponse({ schema: envelopedSchema(PriceZeroReasonDto) })
  createReason(@Body() dto: CreatePriceZeroReasonDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.priceZero.createReason(dto, actor);
  }

  @Patch('price-zero-reasons/:id')
  @RequirePermission(MANAGE)
  @ApiOperation({ summary: 'Actualizar motivo de precio cero' })
  @ApiOkResponse({ schema: envelopedSchema(PriceZeroReasonDto) })
  updateReason(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePriceZeroReasonDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.priceZero.updateReason(id, dto, actor);
  }

  @Delete('price-zero-reasons/:id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(MANAGE)
  @ApiOperation({
    summary: 'Borrar motivo de precio cero sin uso',
    description: 'Uno registrado en algún activo no se borra (406 ASSET_PRICE_ZERO_REASON_IN_USE): se desactiva con PATCH.',
  })
  @ApiOkResponse({ schema: envelopedSchema(PriceZeroReasonDeletedDto) })
  deleteReason(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.priceZero.deleteReason(id, actor);
  }

  @Get('price-zero')
  @UseGuards(AssetReadScopeGuard)
  @ApiOperation({
    summary: 'Activos con precio de compra cero (lista de trabajo)',
    description:
      `Activos con la marca PRICE_ZERO (precio 0 al cargarse; la marca se quita si el precio deja de ser 0), con su ` +
      `motivo si ya se clasificaron. Filtros: costCenterId, classified, reasonId, q. ${READ_SCOPE}`,
  })
  @ApiOkResponse({ schema: envelopedSchema(PriceZeroAssetListDto) })
  list(@Query() query: QueryPriceZeroAssetsDto, @AssetReadScope() scope: ReadableCostCenterScope) {
    return this.priceZero.list(query, scope);
  }

  @Put(':id/price-zero-reason')
  @RequirePermission('asset:update:global')
  @UseGuards(AssetReadScopeGuard)
  @ApiOperation({
    summary: 'Registrar el motivo del precio de compra cero de un activo',
    description:
      'No cambia el precio. Reemplaza el motivo anterior (queda en la auditoría). Requiere asset:update:global y que el ' +
      'activo esté en el alcance de lectura (404 si no). 406 ASSET_PRICE_NOT_ZERO si el activo no tiene la marca ' +
      'PRICE_ZERO; 406 ASSET_PRICE_ZERO_REASON_UNAVAILABLE si el motivo no existe o está inactivo.',
  })
  @ApiOkResponse({ schema: envelopedSchema(PriceZeroAssetDto) })
  setReason(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: SetPriceZeroReasonDto,
    @AssetReadScope() scope: ReadableCostCenterScope,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.priceZero.setReason(id, dto, scope, actor);
  }
}
