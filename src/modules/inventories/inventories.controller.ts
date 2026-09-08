import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Feature } from '../../common/decorators/feature.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import {
  ApiErrorEnvelope,
  ApiSuccessEnvelope,
} from '../../common/swagger/api-envelopes.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';
import {
  CloseInventoryDto,
  CreateInventoryDto,
  QueryInventoriesDto,
  ReportNotFoundDto,
  ReportUnexpectedDto,
  VerifyInventoryAssetDto,
} from './dto/inventory.dto.js';
import { InventoriesService } from './services/inventories.service.js';

@ApiTags(OpenApiTag.Inventories)
@ApiBearerAuth()
@ApiExtraModels(ApiSuccessEnvelope, ApiErrorEnvelope)
@Feature('inventories')
@Controller('inventories')
export class InventoriesController {
  constructor(private readonly inventoriesService: InventoriesService) {}

  @Get()
  @RequirePermission('inventory:read:global')
  @ApiOperation({ summary: 'Listar tomas físicas' })
  list(@Query() query: QueryInventoriesDto) {
    return this.inventoriesService.list(query);
  }

  @Get(':id/progress')
  @RequirePermission('inventory:read:global')
  @ApiOperation({ summary: 'Progreso de verificación' })
  progress(@Param('id', ParseUUIDPipe) id: string) {
    return this.inventoriesService.progress(id);
  }

  @Get(':id/report')
  @RequirePermission('inventory:read:global')
  @ApiOperation({ summary: 'Reporte de discrepancias' })
  report(@Param('id', ParseUUIDPipe) id: string) {
    return this.inventoriesService.report(id);
  }

  @Get(':id')
  @RequirePermission('inventory:read:global')
  @ApiOperation({ summary: 'Detalle de una toma física' })
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.inventoriesService.getById(id);
  }

  @Post()
  @RequirePermission('inventory:create:global')
  @ApiOperation({ summary: 'Programar una toma física' })
  create(
    @Body() dto: CreateInventoryDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.inventoriesService.create(dto, actor);
  }

  @Post(':id/start')
  @RequirePermission('inventory:execute:global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Iniciar toma y congelar snapshot de activos esperados',
  })
  start(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.inventoriesService.start(id, actor);
  }

  @Post(':id/verify-asset')
  @RequirePermission('inventory:execute:global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verificar un activo (escaneo QR)' })
  verifyAsset(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VerifyInventoryAssetDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.inventoriesService.verifyAsset(id, dto, actor);
  }

  @Post(':id/report-not-found')
  @RequirePermission('inventory:execute:global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Declarar un activo esperado como no encontrado' })
  reportNotFound(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReportNotFoundDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.inventoriesService.reportNotFound(id, dto, actor);
  }

  @Post(':id/report-unexpected')
  @RequirePermission('inventory:execute:global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Registrar un activo fuera del alcance' })
  reportUnexpected(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReportUnexpectedDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.inventoriesService.reportUnexpected(id, dto, actor);
  }

  @Post(':id/close')
  @RequirePermission('inventory:execute:global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cerrar la toma y generar el reporte de discrepancias',
  })
  close(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloseInventoryDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.inventoriesService.close(id, dto ?? {}, actor);
  }

  @Post(':id/reconcile')
  @RequirePermission('inventory:execute:global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Solicitar reconciliación (solo el responsable de la toma)',
  })
  requestReconcile(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.inventoriesService.requestReconcile(id, actor);
  }

  @Post(':id/reconcile/approve')
  @RequirePermission('inventory:reconcile:global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Aprobar reconciliación (doble firma; distinto al responsable)',
  })
  approveReconcile(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.inventoriesService.approveReconcile(id, actor);
  }
}
