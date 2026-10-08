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
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
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
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';
import { BoundedFileInterceptor, UPLOAD_LIMITS } from '../../shared/storage/uploads/bounded-file.interceptor.js';
import { envelopedArraySchema } from '../documents/dto/document.responses.js';
import {
  ChangeCostCenterPlacementDto,
  CostCenterAtQueryDto,
  CostCenterTreeQueryDto,
  SuggestCostCenterCodeQueryDto,
} from './dto/cost-center-placement.dto.js';
import { CreateCostCenterDto } from './dto/create-cost-center.dto.js';
import {
  CostCenterCodeSuggestionDto,
  CostCenterHistoryDto,
  CostCenterPlacementAtDto,
  CostCenterPlacementDto,
  CostCenterPrefixMismatchDto,
  CostCenterTreeDto,
} from './dto/responses/cost-center-structure.responses.js';
import { QueryCostCentersDto } from './dto/query-cost-centers.dto.js';
import { CostCenterSyncResponseDto } from './dto/responses/cost-center-sync.response.dto.js';
import { CostCenterResponseDto } from './dto/responses/cost-center.response.dto.js';
import { StructureRemovalResultDto } from './dto/responses/structure-removal.response.dto.js';
import { UpdateCostCenterDto } from './dto/update-cost-center.dto.js';
import {
  CostCenterPlacementService,
  type RequestMeta,
  resolveAt,
} from './services/cost-center-placement.service.js';
import {
  CostCentersService,
  type CsvUpload,
} from './services/cost-centers.service.js';

const meta = (ip: string | undefined, userAgent: string | undefined): RequestMeta => ({
  ip: ip ?? null,
  userAgent: userAgent ?? null,
});

const STRUCTURE_NOTE =
  'Ubicación = unidad organizacional, centro padre y movimiento (true: recibe movimientos; false: agrupador). Tiene historial con vigencias; cost_center guarda la vigente.';

@ApiTags(OpenApiTag.CostCenters)
@ApiBearerAuth()
@ApiExtraModels(
  ApiSuccessEnvelope,
  ApiErrorEnvelope,
  CostCenterResponseDto,
  CostCenterSyncResponseDto,
  CostCenterPlacementDto,
  CostCenterPlacementAtDto,
  CostCenterHistoryDto,
  CostCenterTreeDto,
  CostCenterCodeSuggestionDto,
  CostCenterPrefixMismatchDto,
  StructureRemovalResultDto,
)
@Feature('cost-centers')
@Controller('cost-centers')
export class CostCentersController {
  constructor(
    private readonly costCentersService: CostCentersService,
    private readonly placements: CostCenterPlacementService,
  ) {}

  @Get()
  @RequirePermission('cost_center:read:global')
  @ApiOperation({ summary: 'Listar centros de costo' })
  @ApiResponse({ status: 200, schema: envelopedSchema(CostCenterResponseDto) })
  list(
    @Query() query: QueryCostCentersDto,
  ): Promise<ReadonlyArray<CostCenterResponseDto>> {
    return this.costCentersService.list(query);
  }

  @Post('sync')
  @RequirePermission('cost_center:manage:global')
  @UseInterceptors(BoundedFileInterceptor('file', UPLOAD_LIMITS.COST_CENTER_CSV))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description:
            'CSV con encabezado external_code,name,organizational_unit_code,accepts_assets',
        },
      },
    },
  })
  @ApiOperation({
    summary: 'Sincronizar centros de costo desde CSV',
    description:
      'Formato: external_code,name,organizational_unit_code,accepts_assets. El archivo es la autoridad: crea, actualiza, reactiva y desactiva los ausentes.',
  })
  @ApiResponse({
    status: 201,
    schema: envelopedSchema(CostCenterSyncResponseDto),
  })
  sync(
    @UploadedFile() file: CsvUpload | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CostCenterSyncResponseDto> {
    return this.costCentersService.sync(file, user);
  }

  @Get('tree')
  @RequirePermission('cost_center:read:global')
  @ApiOperation({
    summary: 'Árbol de centros de costo por centro padre a una fecha',
    description: `${STRUCTURE_NOTE} Cada nodo trae la unidad y el movimiento vigentes a esa fecha, los jefes vigentes a esa fecha y los activos (no dados de baja) que hoy apuntan directamente al centro. Un centro que aún no existía en esa fecha no aparece. Por defecto solo centros activos; ?includeArchived=true incluye los archivados.`,
  })
  @ApiOkResponse({ schema: envelopedSchema(CostCenterTreeDto) })
  tree(@Query() query: CostCenterTreeQueryDto): Promise<CostCenterTreeDto> {
    return this.placements.tree(resolveAt(query.at), query.includeArchived ?? false);
  }

  @Get('suggest-code')
  @RequirePermission('cost_center:read:global')
  @ApiOperation({
    summary: 'Sugerir el siguiente código libre para un centro nuevo',
    description:
      'Con parentId de un centro XYZ0 (Z ≠ 0): fixedPrefix=XYZ y el siguiente XYZn libre (sin XYZ5, que es hermano). Con otro padre (regla vieja): bajo X, X000; bajo XY00 (o X000), el siguiente XYnn libre (fixedPrefix=null). Solo con unitId: fixedPrefix = prefijo de la unidad y el siguiente …0 libre (43 → 4310, 4320…; 4 → 4010, 4020…). 400 si no hay ninguno de los dos o la unidad no tiene prefijo. code=null si el rango está lleno.',
  })
  @ApiOkResponse({ schema: envelopedSchema(CostCenterCodeSuggestionDto) })
  suggestCode(@Query() query: SuggestCostCenterCodeQueryDto): Promise<CostCenterCodeSuggestionDto> {
    return this.placements.suggestCode(query.unitId, query.parentId);
  }

  @Get('prefix-mismatches')
  @RequirePermission('cost_center:read:global')
  @ApiOperation({
    summary: 'Centros activos cuyo código no cuadra con su unidad vigente',
    description:
      'Motivo: NO_UNIT (sin unidad), UNIT_WITHOUT_PREFIX (su unidad no tiene prefijo), CODE_OUT_OF_RANGE (el código no empieza por el prefijo; incluye los centros que se movieron de unidad) o EXPECTED_PARENT_MISSING (XYZn sin su XYZ0: 3051 sin 3050; expectedParentCode dice cuál falta). Los existentes nunca se corrigen solos.',
  })
  @ApiOkResponse({ schema: envelopedArraySchema(CostCenterPrefixMismatchDto) })
  prefixMismatches(): Promise<CostCenterPrefixMismatchDto[]> {
    return this.placements.prefixMismatches();
  }

  @Get(':id/history')
  @RequirePermission('cost_center:read:global')
  @ApiOperation({
    summary: 'Historial de un centro de costo: ubicaciones, jefaturas y cambios de nombre/código/estado',
    description: `${STRUCTURE_NOTE} Ubicaciones y jefaturas (vigentes e históricas) y cambios de nombre, código y estado (kind=ATTRIBUTE) juntos, de la más reciente a la más antigua.`,
  })
  @ApiOkResponse({ schema: envelopedSchema(CostCenterHistoryDto) })
  @ApiResponse({ status: 404, schema: errorEnvelopeSchema() })
  history(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string): Promise<CostCenterHistoryDto> {
    return this.placements.history(id);
  }

  @Get(':id/placement')
  @RequirePermission('cost_center:read:global')
  @ApiOperation({
    summary: 'Ubicación de un centro de costo a una fecha',
    description: `${STRUCTURE_NOTE} placement=null si el centro aún no existía en esa fecha.`,
  })
  @ApiOkResponse({ schema: envelopedSchema(CostCenterPlacementAtDto) })
  @ApiResponse({ status: 404, schema: errorEnvelopeSchema() })
  placementAt(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query() query: CostCenterAtQueryDto,
  ): Promise<CostCenterPlacementAtDto> {
    return this.placements.placementAt(id, resolveAt(query.at));
  }

  @Post(':id/placement')
  @RequirePermission('cost_center:manage:global')
  @ApiOperation({
    summary: 'Cambiar la unidad, el centro padre o el movimiento de un centro de costo',
    description: `${STRUCTURE_NOTE} Cierra la ubicación vigente y abre la nueva desde ahora, con el motivo, quién, IP y agente. Nunca cambia el código. Si cambia la unidad o el padre la ubicación queda MANUAL: el conciliador de estructura ya no la mueve (POST /cost-centers/{id}/placement/auto la devuelve a automática). 409 COST_CENTER_PLACEMENT_CYCLE si el padre está por debajo del centro; 409 COST_CENTER_GROUPING_HAS_ASSETS (details[activeAssets]) si queda agrupador con activos; 409 COST_CENTER_PLACEMENT_UNCHANGED si no cambia nada.`,
  })
  @ApiResponse({ status: 201, schema: envelopedSchema(CostCenterPlacementDto) })
  @ApiResponse({ status: 409, schema: errorEnvelopeSchema() })
  changePlacement(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ChangeCostCenterPlacementDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ipAddress: string | undefined,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<CostCenterPlacementDto> {
    return this.placements.changeManually(
      id,
      {
        ...(dto.organizationalUnitId !== undefined ? { unitId: dto.organizationalUnitId } : {}),
        ...(dto.parentId !== undefined ? { parentId: dto.parentId } : {}),
        ...(dto.hasMovement !== undefined ? { hasMovement: dto.hasMovement } : {}),
      },
      {
        reason: dto.reason,
        actorId: user.id,
        source: 'MANUAL',
        // Unidad o padre fijados por una persona: MANUAL (el conciliador ya no los toca). Solo el movimiento: conserva.
        ...(dto.organizationalUnitId !== undefined || dto.parentId !== undefined ? { mode: 'MANUAL' as const } : {}),
        ...meta(ipAddress, userAgent),
      },
    );
  }

  @Get(':id')
  @RequirePermission('cost_center:read:global')
  @ApiOperation({ summary: 'Detalle de centro de costo' })
  @ApiResponse({ status: 200, schema: envelopedSchema(CostCenterResponseDto) })
  @ApiResponse({ status: 404, schema: errorEnvelopeSchema() })
  getById(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<CostCenterResponseDto> {
    return this.costCentersService.getById(id);
  }

  @Post()
  @RequirePermission('cost_center:manage:global')
  @ApiOperation({
    summary: 'Crear centro de costo',
    description:
      'Si la unidad tiene prefijo de código, el código debe empezar por él: 400 COST_CENTER_CODE_OUT_OF_UNIT_RANGE con el rango («Los centros de … van de 4000 a 4999»). Abre el historial de ubicación del centro.',
  })
  @ApiResponse({ status: 201, schema: envelopedSchema(CostCenterResponseDto) })
  create(
    @Body() dto: CreateCostCenterDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ipAddress: string | undefined,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<CostCenterResponseDto> {
    return this.costCentersService.create(dto, user, meta(ipAddress, userAgent));
  }

  @Patch(':id')
  @RequirePermission('cost_center:manage:global')
  @ApiOperation({
    summary: 'Actualizar centro de costo',
    description:
      'Nombre, aceptación de activos y estado. La unidad y el padre solo se aceptan iguales a los vigentes (400 COST_CENTER_PLACEMENT_REQUIRED): se cambian con POST /cost-centers/{id}/placement. Desactivar con activos: 406 COST_CENTER_HAS_ACTIVE_ASSETS con details[{field:"activeAssets", message:"<n>"}].',
  })
  @ApiResponse({ status: 200, schema: envelopedSchema(CostCenterResponseDto) })
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateCostCenterDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ipAddress: string | undefined,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<CostCenterResponseDto> {
    return this.costCentersService.update(id, dto, user, meta(ipAddress, userAgent));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('cost_center:manage:global')
  @ApiOperation({
    summary: 'Eliminar (o archivar) un centro de costo',
    description:
      'Se rechaza si tiene activos no dados de baja: 406 COST_CENTER_HAS_ACTIVE_ASSETS («No puede desactivarse: tiene activos asignados») con details[{field:"activeAssets", message:"<n>"}]; con centros hijos activos: 406 HAS_DEPENDENT_ENTITIES. Sin historia se borra de verdad (deleted=true: también sus jefaturas, roles con alcance en el centro e historial de ubicación; las personas quedan sin centro). Con historia (activos dados de baja, movimientos, traslados, préstamos, tomas/actas, documentos, solicitudes…) se archiva: archived=true y reason.',
  })
  @ApiResponse({ status: 200, schema: envelopedSchema(StructureRemovalResultDto) })
  @ApiResponse({ status: 406, schema: errorEnvelopeSchema() })
  remove(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ipAddress: string | undefined,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<StructureRemovalResultDto> {
    return this.costCentersService.remove(id, user, meta(ipAddress, userAgent));
  }
}
