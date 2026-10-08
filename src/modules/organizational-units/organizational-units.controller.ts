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
import { OrganizationalUnitResponseDto } from './dto/responses/organizational-unit.response.dto.js';
import { UpdateOrganizationalUnitDto } from './dto/update-organizational-unit.dto.js';
import { OrganizationalUnitsService } from './services/organizational-units.service.js';

@ApiTags(OpenApiTag.OrganizationalUnits)
@ApiBearerAuth()
@ApiExtraModels(
  ApiSuccessEnvelope,
  ApiErrorEnvelope,
  OrganizationalUnitResponseDto,
  OrganizationalUnitTreeResponseDto,
  OrgChartPreviewDto,
  OrgChartConfirmDto,
  StructureRemovalResultDto,
  OrgStructureHistoryEventDto,
  UnitPrefixSuggestionDto,
)
@Feature('organizational-units')
@Controller('organizational-units')
export class OrganizationalUnitsController {
  constructor(
    private readonly organizationalUnitsService: OrganizationalUnitsService,
    private readonly orgChart: OrgChartService,
    private readonly historyService: OrgStructureHistoryService,
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
      'Hojas «Organigrama» (Prefijo, Nombre, Tipo, Depende de, Línea, Centro propio, Estado, Acción, Código interno) e «Instrucciones». Solo unidades: los centros de costo se administran en su propia pantalla (Centro propio y Depende de aceptan códigos de centros existentes). Incluye las archivadas. Se edita y se sube a POST /organizational-units/import/preview.',
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
  @ApiOperation({ summary: 'Plantilla vacía del Excel del organigrama (misma estructura, una fila de ejemplo)' })
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
      'Resumen de unidades nuevas/renombradas/movidas/retipadas/a eliminar/a archivar; errores por fila (bloquean) y advertencias (códigos que no cuadran; no bloquean). Solo lee la hoja «Organigrama»: una hoja «Centros de costo» (archivos viejos) se ignora con una advertencia y summary.centers queda en 0. Las filas que no están en el archivo no se tocan. Subir el mismo archivo exportado sin cambios da 0 cambios. 400 ORG_CHART_INVALID_FILE si no trae la hoja «Organigrama».',
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
      'Aplica todo en una transacción, con historial y auditoría. Solo cambia unidades (no toca centros de costo ni exige permisos sobre ellos). 422 ORG_CHART_IMPORT_HAS_ERRORS si tiene errores; 409 ORG_CHART_IMPORT_STALE si el organigrama cambió desde la previsualización; 409 ORG_CHART_IMPORT_CLOSED si ya se aplicó o venció (24 h).',
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
  @ApiOperation({ summary: 'Crear unidad organizacional' })
  @ApiResponse({
    status: 201,
    schema: envelopedSchema(OrganizationalUnitResponseDto),
  })
  create(
    @Body() dto: CreateOrganizationalUnitDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OrganizationalUnitResponseDto> {
    return this.organizationalUnitsService.create(dto, user);
  }

  @Patch(':id')
  @RequirePermission('org_unit:manage:global')
  @ApiOperation({
    summary: 'Actualizar o mover una unidad organizacional',
    description:
      'Cambia nombre, código, tipo y/o dependencia. `parentId` con el UUID de otra unidad mueve esta y todo su subárbol. `parentId: null` la deja como raíz. No se puede colgar de un descendiente propio.',
  })
  @ApiResponse({
    status: 200,
    schema: envelopedSchema(OrganizationalUnitResponseDto),
  })
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateOrganizationalUnitDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OrganizationalUnitResponseDto> {
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
