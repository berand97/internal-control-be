import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
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
  CorrectInventoryItemDto,
  CreateInventoryDto,
  InventoryCalendarQueryDto,
  QueryInventoriesDto,
  ReportNotFoundDto,
  ReportUnexpectedDto,
  RescheduleInventoryDto,
  SetFindingCategoryDto,
  VerifyInventoryAssetDto,
  VoidInventoryItemDto,
} from './dto/inventory.dto.js';
import {
  InventoryCalendarResponseDto,
  InventoryCancelResponseDto,
  InventoryCoverageResponseDto,
  InventoryScheduleResponseDto,
  InventorySummaryDto,
} from './dto/inventory-schedule.responses.js';
import { EnqueueInventoryActDto, ResolveSurplusDto, SetInventoryAccountingCutDto } from './dto/inventory-reconciliation.dto.js';
import {
  InventoryResponsibleCandidatesPageDto,
  QueryInventoryResponsibleCandidatesDto,
} from './dto/inventory-responsible-candidates.dto.js';
import {
  InventoryAccountingCutResponseDto,
  InventoryActStateDto,
  InventoryDetailResponseDto,
  InventoryItemCorrectionDto,
  InventoryItemCorrectionResultDto,
  InventoryItemDto,
  InventoryListResponseDto,
  InventoryProgressResponseDto,
  InventoryReportResponseDto,
} from './dto/inventory.responses.js';
import { envelopedArraySchema } from '../documents/dto/document.responses.js';
import { AccountingCutsService } from './services/accounting-cuts.service.js';
import { InventoriesService } from './services/inventories.service.js';
import { InventoryActService } from './services/inventory-act.service.js';
import { InventorySurplusService } from './services/inventory-surplus.service.js';
import { InventoryCorrectionsService } from './services/inventory-corrections.service.js';
import { InventoryPlanningService } from './services/inventory-planning.service.js';
import { InventoryResponsibleCandidatesService } from './services/inventory-responsible-candidates.service.js';
import { InventorySchedulesService } from './services/inventory-schedules.service.js';
import { InventoryReadAccess } from './services/inventory-read-access.service.js';

const READ_ACCESS_RULE =
  'Trae activos: además de inventory:read:global exige asset:read:global, ser responsable o quien programó la toma, o asset:read:org_unit ' +
  'con todos los centros de la toma (de un solo centro de costo) en su alcance. Si no, 404 RESOURCE_NOT_FOUND, igual que una toma inexistente.';

const ACTOR_RULE =
  'Solo el responsable de la toma o quien tenga inventory:create:global (403 INVENTORY_ACTOR_NOT_ALLOWED), y nunca un ' +
  'jefe vigente de un centro auditado ni el custodio de activos del alcance (403 INVENTORY_CONFLICT_OF_INTEREST).';

@ApiTags(OpenApiTag.Inventories)
@ApiBearerAuth()
@ApiExtraModels(
  ApiSuccessEnvelope,
  ApiErrorEnvelope,
  InventoryScheduleResponseDto,
  InventoryCancelResponseDto,
  InventoryResponsibleCandidatesPageDto,
  InventoryCalendarResponseDto,
  InventoryCoverageResponseDto,
  InventorySummaryDto,
  InventoryDetailResponseDto,
  InventoryListResponseDto,
  InventoryItemDto,
  InventoryProgressResponseDto,
  InventoryReportResponseDto,
  InventoryItemCorrectionDto,
  InventoryItemCorrectionResultDto,
  InventoryAccountingCutResponseDto,
  InventoryActStateDto,
)
@Feature('inventories')
@Controller('inventories')
export class InventoriesController {
  constructor(
    private readonly inventoriesService: InventoriesService,
    private readonly schedules: InventorySchedulesService,
    private readonly planning: InventoryPlanningService,
    private readonly corrections: InventoryCorrectionsService,
    private readonly cuts: AccountingCutsService,
    private readonly surplus: InventorySurplusService,
    private readonly act: InventoryActService,
    private readonly responsibleCandidates: InventoryResponsibleCandidatesService,
    private readonly readAccess: InventoryReadAccess,
  ) {}

  @Get()
  @RequirePermission('inventory:read:global')
  @ApiOperation({ summary: 'Listar tomas físicas' })
  @ApiOkResponse({ schema: envelopedSchema(InventoryListResponseDto) })
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

  @Get('responsible-candidates')
  @RequirePermission('inventory:create:global')
  @ApiOperation({
    summary: 'Candidatos a responsable de una toma',
    description:
      'Usuarios activos con inventory:execute:global (sin él no podrían operar la toma), paginados y filtrables por ' +
      'nombre o usuario (q). Con scope/scopeId excluye a quien sería auditado por la toma: jefe vigente de un centro ' +
      'auditado o custodio de un activo del alcance (misma regla que InventoryActorPolicy, sobre el alcance de hoy). ' +
      'Requiere inventory:create:global, no user:read:global.',
  })
  @ApiOkResponse({ schema: envelopedSchema(InventoryResponsibleCandidatesPageDto) })
  listResponsibleCandidates(@Query() query: QueryInventoryResponsibleCandidatesDto) {
    return this.responsibleCandidates.list(query);
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
  @ApiOperation({ summary: 'Progreso de verificación', description: READ_ACCESS_RULE })
  @ApiOkResponse({ schema: envelopedSchema(InventoryProgressResponseDto) })
  async progress(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.readAccess.assertReadable(id, actor.id);
    return this.inventoriesService.progress(id);
  }

  @Get(':id/report')
  @RequirePermission('inventory:read:global')
  @ApiOperation({ summary: 'Reporte de discrepancias', description: READ_ACCESS_RULE })
  @ApiOkResponse({ schema: envelopedSchema(InventoryReportResponseDto) })
  async report(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.readAccess.assertReadable(id, actor.id);
    return this.inventoriesService.report(id);
  }

  @Get(':id')
  @RequirePermission('inventory:read:global')
  @ApiOperation({ summary: 'Detalle de una toma física', description: READ_ACCESS_RULE })
  @ApiOkResponse({ schema: envelopedSchema(InventoryDetailResponseDto) })
  async getById(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.readAccess.assertReadable(id, actor.id);
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
    description:
      `${ACTOR_RULE} La foto excluye activos dados de baja y marca expectedCodeTemporary en los que tienen código TEMP. ` +
      'actualStartDate es la fecha de Bogotá.',
  })
  @ApiOkResponse({ schema: envelopedSchema(InventoryDetailResponseDto) })
  start(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.inventoriesService.start(id, actor);
  }

  @Post(':id/verify-asset')
  @RequirePermission('inventory:execute:global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verificar un activo (escaneo QR)', description: ACTOR_RULE })
  @ApiOkResponse({ schema: envelopedSchema(InventoryItemDto) })
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
  @ApiOperation({
    summary: 'Declarar un activo esperado como no encontrado',
    description:
      `${ACTOR_RULE} Exige exactamente una causa: causeId (del catálogo, activa) u otherCause (texto 3..500); si no, ` +
      '400 INVENTORY_MISSING_CAUSE_REQUIRED.',
  })
  @ApiOkResponse({ schema: envelopedSchema(InventoryItemDto) })
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
  @ApiOperation({
    summary: 'Registrar un activo fuera del alcance',
    description:
      `${ACTOR_RULE} Un activo dado de baja responde 406 INVENTORY_ASSET_WRITTEN_OFF; uno LOST se registra con ` +
      'wasLost = true y la conciliación no lo recupera.',
  })
  @ApiOkResponse({ schema: envelopedSchema(InventoryItemDto) })
  reportUnexpected(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReportUnexpectedDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.inventoriesService.reportUnexpected(id, dto, actor);
  }

  @Put(':id/items/:itemId/finding-category')
  @RequirePermission('inventory:execute:global')
  @ApiOperation({
    summary: 'Fijar o quitar la categoría de hallazgo de un ítem',
    description:
      `${ACTOR_RULE} Solo tomas en curso e ítems ya verificados y vigentes. La categoría debe estar activa y definida ` +
      '(406 INVENTORY_CATALOG_ENTRY_UNAVAILABLE). La sugerida (suggestedCategory) nunca se asigna sola.',
  })
  @ApiOkResponse({ schema: envelopedSchema(InventoryItemDto) })
  setFindingCategory(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: SetFindingCategoryDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.corrections.setFindingCategory(id, itemId, dto, actor);
  }

  @Post(':id/items/:itemId/correct')
  @RequirePermission('inventory:execute:global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Corregir el resultado de un ítem esperado (con motivo)',
    description:
      `${ACTOR_RULE} Solo tomas en curso. FOUND/MISPLACED exigen actualCondition; MISPLACED, una ubicación distinta ` +
      'de la esperada; MISSING, una causa; PENDING vuelve el ítem a sin verificar. Guarda antes/después en el ' +
      'historial. Un sobrante no se corrige: se anula.',
  })
  @ApiOkResponse({ schema: envelopedSchema(InventoryItemCorrectionResultDto) })
  correct(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: CorrectInventoryItemDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.corrections.correct(id, itemId, dto, actor);
  }

  @Post(':id/items/:itemId/void')
  @RequirePermission('inventory:execute:global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Anular un sobrante registrado por error (con motivo)',
    description: `${ACTOR_RULE} Solo tomas en curso. El ítem queda voided y en el historial; deja de contar.`,
  })
  @ApiOkResponse({ schema: envelopedSchema(InventoryItemCorrectionResultDto) })
  voidSurplus(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: VoidInventoryItemDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.corrections.voidSurplus(id, itemId, dto, actor);
  }

  @Get(':id/items/:itemId/corrections')
  @RequirePermission('inventory:read:global')
  @ApiOperation({ summary: 'Historial de correcciones y anulaciones de un ítem', description: READ_ACCESS_RULE })
  @ApiOkResponse({ schema: envelopedArraySchema(InventoryItemCorrectionDto) })
  async listCorrections(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    await this.readAccess.assertReadable(id, actor.id);
    return this.corrections.listCorrections(id, itemId);
  }

  @Post(':id/close')
  @RequirePermission('inventory:execute:global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cerrar la toma y generar el reporte de discrepancias',
    description:
      `${ACTOR_RULE} Con más del 5 % pendiente exige allowUnverified e inventory:create:global. Los pendientes pasan a ` +
      'NOT_VERIFIED (no son faltantes; la conciliación no los toca). actualEndDate es la fecha de Bogotá.',
  })
  @ApiOkResponse({ schema: envelopedSchema(InventoryDetailResponseDto) })
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
  @ApiOkResponse({ schema: envelopedSchema(InventorySummaryDto) })
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
    description:
      'MISPLACED actualiza la ubicación; MISSING marca LOST; FOUND y MISPLACED con condición distinta actualizan la ' +
      'condición. NOT_VERIFIED y los sobrantes (incluidos los de activos LOST) no cambian nada. En la misma ' +
      'transacción encola el acta OCI-21-37; si el formato no está listo (o falla armarla), la ' +
      'conciliación sigue y el acta queda NOT_ENQUEUED con su motivo (act en la respuesta).',
  })
  @ApiOkResponse({ schema: envelopedSchema(InventoryDetailResponseDto) })
  approveReconcile(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.inventoriesService.approveReconcile(id, actor);
  }

  @Put(':id/accounting-cut')
  @RequirePermission('inventory:create:global')
  @ApiOperation({
    summary: 'Asociar o desasociar el corte contable de una toma',
    description:
      'Solo tomas PLANNED o IN_PROGRESS (406 INVALID_STATE después de cerrar). Con corte, la toma se compara contra ' +
      'él (valor en libros de sus líneas y, si no traen, depreciación hasta la fecha del corte); sin corte, contra la ' +
      'foto del sistema.',
  })
  @ApiOkResponse({ schema: envelopedSchema(InventoryAccountingCutResponseDto) })
  setAccountingCut(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetInventoryAccountingCutDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.cuts.setForInventory(id, dto, actor);
  }

  @Post(':id/items/:itemId/resolve-surplus')
  @RequirePermission('inventory:execute:global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resolver un sobrante sin activo (toma cerrada, antes de aprobar la conciliación)',
    description:
      `${ACTOR_RULE} CREATE_ASSET exige además asset:create:global y los datos del activo: se crea en el centro de la ` +
      'toma (alcance COST_CENTER) o en costCenterId (otros alcances), con movimiento REGISTRATION que cita la toma, y ' +
      'se enlaza al ítem en una transacción. LEAVE_UNRESOLVED deja el motivo y admite cambiar luego a CREATE_ASSET. ' +
      'Un sobrante de un activo LOST responde 406 INVENTORY_SURPLUS_WAS_LOST; uno con activo registrado, anulado o ya ' +
      'creado, 406 INVENTORY_SURPLUS_NOT_RESOLVABLE.',
  })
  @ApiOkResponse({ schema: envelopedSchema(InventoryItemDto) })
  resolveSurplus(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: ResolveSurplusDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.surplus.resolve(id, itemId, dto, actor);
  }

  @Post(':id/act/enqueue')
  @RequirePermission('inventory:create:global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Encolar el acta OCI-21-37 que la conciliación no pudo encolar',
    description:
      'Solo tomas RECONCILED con acta NOT_ENQUEUED. Firman el responsable de la toma (RESPONSABLE) y quien aprobó la ' +
      'conciliación (AUDITA). Si el formato sigue sin código SGC o firmantes: 409 DOCUMENT_FORMAT_NOT_READY; otro ' +
      'error al armar el acta: 406 INVALID_STATE. En ambos, error.details[0] = { field: reason, message: <reason> }. ' +
      'Si el responsable de la toma es quien aprobó la conciliación, la separación de funciones exige un sustituto para ' +
      'AUDITA (signerSubstitutions); sin él, la razón es ENQUEUE_FAILED con el mensaje DOCUMENT_SIGNER_DUPLICATED.',
  })
  @ApiOkResponse({ schema: envelopedSchema(InventoryActStateDto) })
  enqueueAct(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EnqueueInventoryActDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.act.retryEnqueue(id, actor, dto.signerSubstitutions);
  }
}
