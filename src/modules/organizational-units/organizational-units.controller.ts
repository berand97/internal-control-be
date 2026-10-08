import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Feature } from '../../common/decorators/feature.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import {
  ApiErrorEnvelope,
  ApiSuccessEnvelope,
  envelopedSchema,
  errorEnvelopeSchema,
} from '../../common/swagger/api-envelopes.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import { envelopedArraySchema } from '../documents/dto/document.responses.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';
import { BoundedFileInterceptor, UPLOAD_LIMITS } from '../../shared/storage/uploads/bounded-file.interceptor.js';
import { StructureRemovalResultDto } from '../cost-centers/dto/responses/structure-removal.response.dto.js';
import { OrgStructureHistoryService } from '../cost-centers/services/org-structure-history.service.js';
import { StructureReconcilerService } from '../cost-centers/services/structure-reconciler.service.js';
import { ReconcileStructureDto } from '../cost-centers/dto/reconcile-structure.dto.js';
import {
  StructurePendingDto,
  StructureReconcilePreviewDto,
  StructureReconcileResultDto,
} from '../cost-centers/dto/responses/structure-reconcile.responses.js';
import { OrgStructureHistoryEventDto } from './dto/responses/org-structure-history.response.dto.js';
import {
  OrgChartConfirmDto,
  OrgChartPreviewDto,
} from './dto/responses/org-chart.responses.js';
import { XLSX_MIME } from './org-chart/org-chart-workbook.js';
import { type OrgChartFile, OrgChartService, type OrgChartUpload } from './org-chart/org-chart.service.js';
import { CreateOrganizationalUnitDto } from './dto/create-organizational-unit.dto.js';
import {
  IncludeArchivedQueryDto,
  QueryOrganizationalUnitsDto,
  SuggestUnitPrefixQueryDto,
} from './dto/query-organizational-units.dto.js';
import { UnitPrefixSuggestionDto } from './dto/responses/unit-prefix-suggestion.response.dto.js';
import { OrganizationalUnitTreeResponseDto } from './dto/responses/organizational-unit-tree.response.dto.js';
import {
  OrganizationalUnitResponseDto,
  OrganizationalUnitSaveResponseDto,
} from './dto/responses/organizational-unit.response.dto.js';
import { UpdateOrganizationalUnitDto } from './dto/update-organizational-unit.dto.js';
import { OrganizationalUnitsService } from './services/organizational-units.service.js';

@ApiTags(OpenApiTag.OrganizationalUnits)
@ApiBearerAuth()
@ApiExtraModels(
  ApiSuccessEnvelope,
  ApiErrorEnvelope,
  OrganizationalUnitResponseDto,
  OrganizationalUnitSaveResponseDto,
  OrganizationalUnitTreeResponseDto,
  OrgChartPreviewDto,
  OrgChartConfirmDto,
  StructureRemovalResultDto,
  OrgStructureHistoryEventDto,
  UnitPrefixSuggestionDto,
  StructureReconcilePreviewDto,
  StructureReconcileResultDto,
  StructurePendingDto,
)
@Feature('organizational-units')
@Controller('organizational-units')
export class OrganizationalUnitsController {
  constructor(
    private readonly organizationalUnitsService: OrganizationalUnitsService,
    private readonly orgChart: OrgChartService,
    private readonly historyService: OrgStructureHistoryService,
    private readonly reconciler: StructureReconcilerService,
  ) {}

  @Get('export')
  @RequirePermission('org_unit:read:global')
  @ApiProduces(XLSX_MIME)
  @ApiOkResponse({
    description: 'Archivo .xlsx (Content-Disposition: attachment; filename=organigrama-AAAA-MM-DD.xlsx)',
    content: { [XLSX_MIME]: { schema: { type: 'string', format: 'binary' } } },
  })
  @ApiOperation({
    summary: 'Exportar el organigrama (unidades organizacionales) a Excel',
    description:
      'Hojas «Organigrama» (Prefijo, Nombre, Tipo, Depende de, Línea, Centro propio, Estado, Acción, Código interno) e «Instrucciones». Solo unidades: los centros de costo se administran en su propia pantalla (Depende de acepta códigos de centros existentes; Centro propio también uno que aún no exista: queda pendiente y se amarra cuando el centro se crea). Incluye las archivadas. Trae una hoja oculta «_sello» (hora exacta de la descarga, revisión de la estructura y la huella de cada fila) con la que la previsualización sabe qué cambió la persona. Se edita y se sube a POST /organizational-units/import/preview.',
  })
  async export(@Res() response: Response): Promise<void> {
    this.sendXlsx(response, await this.orgChart.export());
  }

  @Get('template')
  @RequirePermission('org_unit:manage:global')
  @ApiProduces(XLSX_MIME)
  @ApiOkResponse({
    description: 'Archivo .xlsx (plantilla-organigrama.xlsx)',
    content: { [XLSX_MIME]: { schema: { type: 'string', format: 'binary' } } },
  })
  @ApiOperation({
    summary: 'Plantilla vacía del Excel del organigrama (misma estructura; el ejemplo va en Instrucciones)',
    description: 'La hoja «Organigrama» va vacía: subida tal cual no cambia nada. La fila de ejemplo de plantillas viejas (4 Vicerrectoría Financiera, 4010) se ignora al subirla.',
  })
  async template(@Res() response: Response): Promise<void> {
    this.sendXlsx(response, await this.orgChart.template());
  }

  @Post('import/preview')
  @RequirePermission('org_unit:manage:global')
  @UseInterceptors(BoundedFileInterceptor('file', UPLOAD_LIMITS.EXCEL_IMPORT))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary', description: 'Excel del organigrama (.xlsx)' } },
    },
  })
  @ApiOperation({
    summary: 'Previsualizar un Excel del organigrama (no cambia nada)',
    description:
      'Resumen de unidades nuevas/renombradas/movidas/retipadas/a eliminar/a archivar; errores por fila (bloquean) y advertencias (códigos que no cuadran; no bloquean). Solo lee la hoja «Organigrama»: una hoja «Centros de costo» (archivos viejos) se ignora con una advertencia y summary.centers queda en 0. Las filas que no están en el archivo no se tocan. Subir el mismo archivo exportado sin cambios da 0 cambios. Con el sello oculto del archivo: una fila o columna que la persona no tocó se ignora aunque el sistema haya cambiado después (no revierte cambios de otros); una columna que tocó y que otra persona cambió después es un conflicto (conflicts[] y un error de fila: hay que descargar de nuevo); si el archivo ya dice lo mismo que el sistema no hay cambio ni conflicto. Con o sin sello: un Código interno que ya no existe no se vuelve a crear (advertencia); una archivada no se reactiva salvo que la persona cambie Estado (sin sello: solo si se archivó antes de la fecha del archivo); una fila nueva igual a una unidad activa (mismo prefijo, o mismo nombre bajo el mismo jefe) se toma como ella. fileAppliedBefore avisa si un archivo idéntico ya se aplicó; fileAgeDays, los días desde la descarga (más de 7: advertencia). 400 ORG_CHART_INVALID_FILE si no trae la hoja «Organigrama».',
  })
  @ApiResponse({ status: 201, schema: envelopedSchema(OrgChartPreviewDto) })
  @ApiResponse({ status: 400, schema: errorEnvelopeSchema() })
  preview(
    @UploadedFile() file: OrgChartUpload | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OrgChartPreviewDto> {
    return this.orgChart.preview(file, user);
  }

  @Post('import/:previewId/confirm')
  @RequirePermission('org_unit:manage:global')
  @ApiOperation({
    summary: 'Aplicar una previsualización del organigrama',
    description:
      'Aplica todo en una transacción, con historial y auditoría. Solo cambia unidades (no toca centros de costo ni exige permisos sobre ellos). 422 ORG_CHART_IMPORT_HAS_ERRORS si tiene errores; 409 ORG_CHART_IMPORT_CONFLICT si otra persona cambió las mismas columnas después de la descarga del archivo; 409 ORG_CHART_IMPORT_STALE si el organigrama cambió desde la previsualización; 409 ORG_CHART_IMPORT_CLOSED si ya se aplicó o venció (24 h).',
  })
  @ApiResponse({ status: 201, schema: envelopedSchema(OrgChartConfirmDto) })
  @ApiResponse({ status: 409, schema: errorEnvelopeSchema() })
  @ApiResponse({ status: 422, schema: errorEnvelopeSchema() })
  confirm(
    @Param('previewId', new ParseUUIDPipe({ version: '4' })) previewId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OrgChartConfirmDto> {
    return this.orgChart.confirm(previewId, user);
  }

  @Get('tree')
  @RequirePermission('org_unit:read:global')
  @ApiOperation({
    summary: 'Árbol organizacional',
    description: 'Por defecto solo unidades activas; ?includeArchived=true incluye las archivadas.',
  })
  @ApiResponse({
    status: 200,
    schema: envelopedSchema(OrganizationalUnitTreeResponseDto),
  })
  tree(@Query() query: IncludeArchivedQueryDto): Promise<ReadonlyArray<OrganizationalUnitTreeResponseDto>> {
    return this.organizationalUnitsService.tree(query.includeArchived ?? false);
  }

  @Get('suggest-prefix')
  @RequirePermission('org_unit:read:global')
  @ApiOperation({
    summary: 'Sugerir el prefijo de una unidad nueva',
    description:
      'fixedPrefix = prefijo del ancestro más cercano con prefijo (parentId o sus ancestros; "" si ninguno); suggested = fixedPrefix + el primer dígito 1–9 libre entre las unidades activas (null si no queda); taken = los ya usados de ese nivel.',
  })
  @ApiOkResponse({ schema: envelopedSchema(UnitPrefixSuggestionDto) })
  suggestPrefix(@Query() query: SuggestUnitPrefixQueryDto): Promise<UnitPrefixSuggestionDto> {
    return this.organizationalUnitsService.suggestPrefix(query.parentId);
  }

  @Get('reconcile/preview')
  @RequirePermission('org_unit:manage:global')
  @ApiOperation({
    summary: 'Vista previa de «Recalcular estructura»',
    description:
      'Compara la estructura con lo que piden los códigos: relocations (centros AUTO cuya unidad por prefijo más largo es otra), reparents (centros AUTO cuyo padre por regla XYZ0 es otro), headLinks (centros propios pendientes cuyo centro ya existe, o amarrados que cambiaron de código), headUnlinks (centros propios archivados o borrados: vuelven a pendiente) y manualExceptions (ubicaciones MANUAL que no coinciden: no se tocan). No cambia nada. hash va como expectedHash en POST /organizational-units/reconcile.',
  })
  @ApiOkResponse({ schema: envelopedSchema(StructureReconcilePreviewDto) })
  reconcilePreview(): Promise<StructureReconcilePreviewDto> {
    return this.reconciler.preview();
  }

  @Post('reconcile')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('org_unit:manage:global')
  @ApiOperation({
    summary: 'Recalcular estructura',
    description:
      'Aplica en una transacción lo que muestra la vista previa: placements nuevos con origen y marca AUTO, amarres del centro propio, historial (motivo «Recalcular estructura») y auditoría STRUCTURE_RECONCILED con conteos. Idempotente: una segunda vez no cambia nada. Con expectedHash: 409 STRUCTURE_RECONCILE_STALE si la estructura cambió desde la vista previa.',
  })
  @ApiOkResponse({ schema: envelopedSchema(StructureReconcileResultDto) })
  @ApiResponse({ status: 409, schema: errorEnvelopeSchema() })
  reconcile(
    @Body() dto: ReconcileStructureDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ipAddress: string | undefined,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<StructureReconcileResultDto> {
    return this.reconciler.reconcileAll(user.id, dto.expectedHash, { ip: ipAddress ?? null, userAgent: userAgent ?? null });
  }

  @Get('structure-pending')
  @RequirePermission('org_unit:read:global')
  @ApiOperation({
    summary: 'Pendientes de la estructura',
    description:
      'pendingHeadCenters: unidades activas con centro propio escrito por código que aún no existe (o está archivado); centersWithoutUnit: centros activos cuyo código no empieza por el prefijo de ninguna unidad activa; mismatches: lo mismo que GET /cost-centers/prefix-mismatches; manualExceptions: ubicaciones MANUAL que no coinciden con la regla.',
  })
  @ApiOkResponse({ schema: envelopedSchema(StructurePendingDto) })
  structurePending(): Promise<StructurePendingDto> {
    return this.reconciler.pending();
  }

  @Get(':id/history')
  @RequirePermission('org_unit:read:global')
  @ApiOperation({
    summary: 'Historial de una unidad: nombre, código, tipo, padre, prefijo, línea, centro propio y estado',
    description: 'Un evento por campo cambiado, del más reciente al más antiguo (cambios manuales y por el Excel del organigrama).',
  })
  @ApiOkResponse({ schema: envelopedArraySchema(OrgStructureHistoryEventDto) })
  @ApiResponse({ status: 404, schema: errorEnvelopeSchema() })
  async history(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<ReadonlyArray<OrgStructureHistoryEventDto>> {
    await this.organizationalUnitsService.getById(id);
    return this.historyService.list('ORG_UNIT', id);
  }

  @Get(':id/descendants')
  @RequirePermission('org_unit:read:global')
  @ApiOperation({ summary: 'Subárbol de una unidad' })
  @ApiResponse({
    status: 200,
    schema: envelopedSchema(OrganizationalUnitTreeResponseDto),
  })
  descendants(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<ReadonlyArray<OrganizationalUnitTreeResponseDto>> {
    return this.organizationalUnitsService.descendants(id);
  }

  @Get(':id/ancestors')
  @RequirePermission('org_unit:read:global')
  @ApiOperation({ summary: 'Cadena hacia la raíz' })
  @ApiResponse({
    status: 200,
    schema: envelopedSchema(OrganizationalUnitResponseDto),
  })
  ancestors(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<ReadonlyArray<OrganizationalUnitResponseDto>> {
    return this.organizationalUnitsService.ancestors(id);
  }

  @Get()
  @RequirePermission('org_unit:read:global')
  @ApiOperation({ summary: 'Listar unidades organizacionales' })
  @ApiResponse({
    status: 200,
    schema: envelopedSchema(OrganizationalUnitResponseDto),
  })
  list(
    @Query() query: QueryOrganizationalUnitsDto,
  ): Promise<ReadonlyArray<OrganizationalUnitResponseDto>> {
    return this.organizationalUnitsService.list(query);
  }

  @Get(':id')
  @RequirePermission('org_unit:read:global')
  @ApiOperation({ summary: 'Detalle de unidad organizacional' })
  @ApiResponse({
    status: 200,
    schema: envelopedSchema(OrganizationalUnitResponseDto),
  })
  @ApiResponse({ status: 404, schema: errorEnvelopeSchema() })
  getById(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<OrganizationalUnitResponseDto> {
    return this.organizationalUnitsService.getById(id);
  }

  @Post()
  @RequirePermission('org_unit:manage:global')
  @ApiOperation({
    summary: 'Crear unidad organizacional',
    description:
      'headCostCenterCode con un código que aún no existe se guarda como centro propio pendiente (warnings) y se amarra solo cuando el centro se crea. Un prefijo que no empieza por el del jefe es solo una advertencia (warnings); el mismo prefijo del jefe: 400 ORG_UNIT_PREFIX_OUT_OF_PARENT; el de otra unidad activa: 409 ORG_UNIT_CODE_PREFIX_EXISTS. En la misma transacción concilia los centros del prefijo (unidad por prefijo más largo).',
  })
  @ApiResponse({
    status: 201,
    schema: envelopedSchema(OrganizationalUnitSaveResponseDto),
  })
  create(
    @Body() dto: CreateOrganizationalUnitDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OrganizationalUnitSaveResponseDto> {
    return this.organizationalUnitsService.create(dto, user);
  }

  @Patch(':id')
  @RequirePermission('org_unit:manage:global')
  @ApiOperation({
    summary: 'Actualizar o mover una unidad organizacional',
    description:
      'Cambia nombre, código, tipo y/o dependencia. `parentId` con el UUID de otra unidad mueve esta y todo su subárbol. `parentId: null` la deja como raíz. No se puede colgar de un descendiente propio. headCostCenterCode con un código que aún no existe queda pendiente (warnings). Un prefijo que no empieza por el del jefe (unidad movida a otro jefe) es solo una advertencia y la unidad conserva sus centros. Si cambian el prefijo, el padre o el estado, concilia los centros del prefijo viejo y del nuevo en la misma transacción.',
  })
  @ApiResponse({
    status: 200,
    schema: envelopedSchema(OrganizationalUnitSaveResponseDto),
  })
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateOrganizationalUnitDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OrganizationalUnitSaveResponseDto> {
    return this.organizationalUnitsService.update(id, dto, user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('org_unit:manage:global')
  @ApiOperation({
    summary: 'Eliminar (o archivar) una unidad organizacional',
    description:
      'Con unidades hijas activas: 406 ORG_UNIT_HAS_CHILDREN; con centros activos: 406 HAS_DEPENDENT_ENTITIES (details activeCostCenters). Si no, se borra de verdad (deleted=true); si algo la referencia (hijas o centros inactivos, historial de ubicación de centros…) se archiva (archived=true, reason).',
  })
  @ApiResponse({ status: 200, schema: envelopedSchema(StructureRemovalResultDto) })
  @ApiResponse({ status: 406, schema: errorEnvelopeSchema() })
  remove(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<StructureRemovalResultDto> {
    return this.organizationalUnitsService.remove(id, user);
  }

  private sendXlsx(response: Response, file: OrgChartFile): void {
    response.setHeader('Content-Type', XLSX_MIME);
    response.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    response.setHeader('Cache-Control', 'no-store');
    response.send(file.body);
  }
}
