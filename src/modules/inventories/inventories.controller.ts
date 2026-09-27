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
  ApiCreatedResponse,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Feature } from '../../common/decorators/feature.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import {
  ApiErrorEnvelope,
  ApiSuccessEnvelope,
  envelopedSchema,
} from '../../common/swagger/api-envelopes.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';
import {
  CancelInventoryDto,
  CloseInventoryDto,
  CreateInventoryDto,
  InventoryCalendarQueryDto,
  QueryInventoriesDto,
  ReportNotFoundDto,
  ReportUnexpectedDto,
  RescheduleInventoryDto,
  VerifyInventoryAssetDto,
} from './dto/inventory.dto.js';
import {
  InventoryCalendarResponseDto,
  InventoryCancelResponseDto,
  InventoryCoverageResponseDto,
  InventoryScheduleResponseDto,
} from './dto/inventory-schedule.responses.js';
import { InventoriesService } from './services/inventories.service.js';
import { InventoryPlanningService } from './services/inventory-planning.service.js';
import { InventorySchedulesService } from './services/inventory-schedules.service.js';

@ApiTags(OpenApiTag.Inventories)
@ApiBearerAuth()
@ApiExtraModels(
  ApiSuccessEnvelope,
  ApiErrorEnvelope,
  InventoryScheduleResponseDto,
  InventoryCancelResponseDto,
  InventoryCalendarResponseDto,
  InventoryCoverageResponseDto,
)
@Feature('inventories')
@Controller('inventories')
export class InventoriesController {
  constructor(
    private readonly inventoriesService: InventoriesService,
    private readonly schedules: InventorySchedulesService,
    private readonly planning: InventoryPlanningService,
  ) {}

  @Get()
  @RequirePermission('inventory:read:global')
  @ApiOperation({ summary: 'Listar tomas físicas' })
  list(@Query() query: QueryInventoriesDto) {
    return this.inventoriesService.list(query);
  }

  @Get('calendar')
  @RequirePermission('inventory:read:global')
  @ApiOperation({
    summary: 'Calendario de tomas',
    description:
      'Tomas cuyo rango planeado cruza la ventana [from, to] (máximo 93 días), con sus choques de fechas y, si hay ' +
      'umbral configurado, las semanas ISO con demasiadas tomas.',
  })
  @ApiOkResponse({ schema: envelopedSchema(InventoryCalendarResponseDto) })
  calendar(@Query() query: InventoryCalendarQueryDto) {
    return this.planning.calendar(query);
  }

  @Get('coverage')
  @RequirePermission('inventory:read:global')
  @ApiOperation({
    summary: 'Cobertura de tomas por centro de costo',
    description:
      'Centros con activos actuales: última toma cerrada que los incluyó, su resultado, días desde entonces y la ' +
      'próxima toma programada. Primero los nunca revisados.',
  })
  @ApiOkResponse({ schema: envelopedSchema(InventoryCoverageResponseDto) })
  coverage() {
    return this.planning.coverage();
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
  @ApiOperation({
    summary: 'Programar una toma física',
    description:
      'Crea la toma PLANNED, sus recordatorios y el aviso inicial (correo a los jefes vigentes del centro con correo, ' +
      'notificación en la aplicación a jefes con usuario y al responsable). Los choques de fechas con otras tomas ' +
      'no bloquean: vuelven en warnings y conflicts.',
  })
  @ApiCreatedResponse({ schema: envelopedSchema(InventoryScheduleResponseDto) })
  create(
    @Body() dto: CreateInventoryDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.schedules.schedule(dto, actor);
  }

  @Post(':id/reschedule')
  @RequirePermission('inventory:create:global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reprogramar una toma planeada',
    description:
      'Mueve las fechas (inicio desde hoy), invalida los recordatorios pendientes, crea los de las nuevas fechas y ' +
      'avisa a los mismos destinatarios. Solo tomas PLANNED.',
  })
  @ApiOkResponse({ schema: envelopedSchema(InventoryScheduleResponseDto) })
  reschedule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RescheduleInventoryDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.schedules.reschedule(id, dto, actor);
  }

  @Post(':id/cancel')
  @RequirePermission('inventory:create:global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancelar una toma planeada',
    description: 'Guarda el motivo, detiene los recordatorios pendientes y avisa la cancelación. Solo tomas PLANNED.',
  })
  @ApiOkResponse({ schema: envelopedSchema(InventoryCancelResponseDto) })
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelInventoryDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.schedules.cancel(id, dto, actor);
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
