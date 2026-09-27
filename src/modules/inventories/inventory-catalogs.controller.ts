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
import {
  CreateFindingCategoryDto,
  CreateMissingCauseDto,
  UpdateFindingCategoryDto,
  UpdateMissingCauseDto,
} from './dto/inventory-catalog.dto.js';
import {
  InventoryDeletedResponseDto,
  InventoryFindingCategoryDto,
  InventoryMissingCauseDto,
  InventoryOtherCauseUsageResponseDto,
} from './dto/inventory.responses.js';
import { InventoryCatalogsService } from './services/inventory-catalogs.service.js';

const MANAGE = 'inventory_catalog:manage:global';
const IN_USE =
  'Una opción ya usada por algún ítem no se borra (406 INVENTORY_CATALOG_ENTRY_IN_USE): se desactiva con PATCH.';

/** Catálogos de la toma física: categorías de hallazgo y causas de faltante. */
@ApiTags(OpenApiTag.Inventories)
@ApiBearerAuth()
@ApiExtraModels(
  ApiSuccessEnvelope,
  ApiErrorEnvelope,
  InventoryFindingCategoryDto,
  InventoryMissingCauseDto,
  InventoryOtherCauseUsageResponseDto,
  InventoryDeletedResponseDto,
)
@Feature('inventories')
@Controller('inventories/catalogs')
export class InventoryCatalogsController {
  constructor(private readonly catalogs: InventoryCatalogsService) {}

  @Get('finding-categories')
  @RequirePermission('inventory:read:global')
  @ApiOperation({
    summary: 'Categorías de hallazgo',
    description: 'Todas, activas o no, por sortOrder. pendingDefinition = sin definición: no se sugiere ni se asigna.',
  })
  @ApiOkResponse({ schema: envelopedArraySchema(InventoryFindingCategoryDto) })
  listFindingCategories() {
    return this.catalogs.listFindingCategories();
  }

  @Post('finding-categories')
  @RequirePermission(MANAGE)
  @ApiOperation({ summary: 'Crear categoría de hallazgo' })
  @ApiCreatedResponse({ schema: envelopedSchema(InventoryFindingCategoryDto) })
  createFindingCategory(@Body() dto: CreateFindingCategoryDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.catalogs.createFindingCategory(dto, actor);
  }

  @Patch('finding-categories/:code')
  @RequirePermission(MANAGE)
  @ApiOperation({ summary: 'Actualizar categoría de hallazgo (el código no cambia)' })
  @ApiOkResponse({ schema: envelopedSchema(InventoryFindingCategoryDto) })
  updateFindingCategory(
    @Param('code') code: string,
    @Body() dto: UpdateFindingCategoryDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.catalogs.updateFindingCategory(code, dto, actor);
  }

  @Delete('finding-categories/:code')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(MANAGE)
  @ApiOperation({ summary: 'Borrar categoría de hallazgo sin uso', description: IN_USE })
  @ApiOkResponse({ schema: envelopedSchema(InventoryDeletedResponseDto) })
  deleteFindingCategory(@Param('code') code: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.catalogs.deleteFindingCategory(code, actor);
  }

  @Get('missing-causes')
  @RequirePermission('inventory:read:global')
  @ApiOperation({ summary: 'Causas de faltante', description: 'Todas, activas o no. Nace vacío: "Otra" siempre existe.' })
  @ApiOkResponse({ schema: envelopedArraySchema(InventoryMissingCauseDto) })
  listMissingCauses() {
    return this.catalogs.listMissingCauses();
  }

  @Get('missing-causes/other-usage')
  @RequirePermission('inventory:read:global')
  @ApiOperation({
    summary: 'Textos de la causa "Otra", agrupados y contados',
    description:
      'Para que Control Interno cree causas con los textos frecuentes. Agrupa sin distinguir mayúsculas ni espacios ' +
      'repetidos; máximo 200 grupos, del más usado al menos.',
  })
  @ApiOkResponse({ schema: envelopedSchema(InventoryOtherCauseUsageResponseDto) })
  otherCauseUsage() {
    return this.catalogs.otherCauseUsage();
  }

  @Post('missing-causes')
  @RequirePermission(MANAGE)
  @ApiOperation({ summary: 'Crear causa de faltante', description: 'El nombre no se repite (sin distinguir mayúsculas).' })
  @ApiCreatedResponse({ schema: envelopedSchema(InventoryMissingCauseDto) })
  createMissingCause(@Body() dto: CreateMissingCauseDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.catalogs.createMissingCause(dto, actor);
  }

  @Patch('missing-causes/:id')
  @RequirePermission(MANAGE)
  @ApiOperation({ summary: 'Actualizar causa de faltante' })
  @ApiOkResponse({ schema: envelopedSchema(InventoryMissingCauseDto) })
  updateMissingCause(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMissingCauseDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.catalogs.updateMissingCause(id, dto, actor);
  }

  @Delete('missing-causes/:id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(MANAGE)
  @ApiOperation({ summary: 'Borrar causa de faltante sin uso', description: IN_USE })
  @ApiOkResponse({ schema: envelopedSchema(InventoryDeletedResponseDto) })
  deleteMissingCause(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.catalogs.deleteMissingCause(id, actor);
  }
}
