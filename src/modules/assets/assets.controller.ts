import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiExtraModels,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ErrorCode } from '../../common/constants/error-code.enum.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Feature } from '../../common/decorators/feature.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { ApiException } from '../../common/exceptions/api.exception.js';
import {
  ApiErrorEnvelope,
  ApiSuccessEnvelope,
  envelopedSchema,
  errorEnvelopeSchema,
} from '../../common/swagger/api-envelopes.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';
import type { ReadableCostCenterScope } from '../roles/services/cost-center-scope.js';
import {
  AssetReadCatalog,
  AssetReadScope,
  AssetReadScopeGuard,
} from './asset-read-scope.guard.js';
import { BulkCreateAssetsDto } from './dto/bulk-create-assets.dto.js';
import { ChangeAssetStatusDto } from './dto/change-asset-status.dto.js';
import { CommitAssetImportDto } from './dto/commit-asset-import.dto.js';
import { CreateAssetDto } from './dto/create-asset.dto.js';
import { QueryAssetsDto } from './dto/query-assets.dto.js';
import { QueryTimelineDto } from './dto/query-timeline.dto.js';
import { AssetTimelineResponseDto } from './dto/responses/asset-timeline.response.dto.js';
import { ReassignCostCenterDto } from './dto/reassign-cost-center.dto.js';
import { ReassignLocationDto } from './dto/reassign-location.dto.js';
import {
  AcquisitionTypeResponseDto,
  AssetBulkResultResponseDto,
  AssetImportPreviewResponseDto,
  AssetListResponseDto,
  AssetResponseDto,
} from './dto/responses/asset.response.dto.js';
import { UpdateAssetDto } from './dto/update-asset.dto.js';
import { WriteOffAssetDto } from './dto/write-off-asset.dto.js';
import { ImportMode } from './enums/import-mode.enum.js';
import { AssetTimelineService } from './services/asset-timeline.service.js';
import { AssetsService } from './services/assets.service.js';

const READ_SCOPE_DESCRIPTION =
  'Requiere asset:read:global (todos los activos) o asset:read:org_unit (solo activos cuyo centro de costo actual está en las asignaciones de rol vigentes del usuario con alcance COST_CENTER).';

const READ_FORBIDDEN_RESPONSE = {
  status: 403,
  description:
    'INSUFFICIENT_PERMISSIONS: no tiene asset:read:global ni asset:read:org_unit. SCOPE_NO_COST_CENTER: tiene asset:read:org_unit pero ninguna asignación vigente con alcance COST_CENTER. SCOPE_ORG_UNIT_UNRESOLVED: tiene asset:read:org_unit solo por asignaciones con alcance ORG_UNIT, que aún no dan centros de costo. Las dos últimas traen action CONTACT_SUPPORT.',
  content: {
    'application/json': {
      schema: errorEnvelopeSchema(),
      examples: {
        sinCentro: {
          value: {
            type: 'ERROR',
            action: 'CONTACT_SUPPORT',
            error: {
              code: 'SCOPE_NO_COST_CENTER',
              message:
                'Tu rol solo da acceso a los centros de costo que tengas asignados y no tienes ninguno. Pide a Control Interno que te asigne el rol sobre tu centro de costo.',
            },
          },
        },
        unidadSinResolver: {
          value: {
            type: 'ERROR',
            action: 'CONTACT_SUPPORT',
            error: {
              code: 'SCOPE_ORG_UNIT_UNRESOLVED',
              message:
                'Tu rol está asignado a una unidad organizacional, pero aún no está definido qué centros de costo cubre una unidad, así que no da acceso. Pide a Control Interno que te asigne el rol sobre un centro de costo.',
            },
          },
        },
        sinPermiso: {
          value: {
            type: 'ERROR',
            action: 'CANCEL',
            error: {
              code: 'INSUFFICIENT_PERMISSIONS',
              message: 'Requiere permiso asset:read:global o asset:read:org_unit',
            },
          },
        },
      },
    },
  },
};

const NOT_FOUND_RESPONSE = {
  status: 404,
  description:
    'RESOURCE_NOT_FOUND: el activo no existe o está fuera del alcance del usuario (respuesta idéntica en ambos casos).',
  schema: errorEnvelopeSchema(),
};

export interface CsvUpload {
  readonly originalname: string;
  readonly buffer: Buffer;
}

@ApiTags(OpenApiTag.Assets)
@ApiBearerAuth()
@ApiExtraModels(
  ApiSuccessEnvelope,
  ApiErrorEnvelope,
  AssetResponseDto,
  AssetListResponseDto,
  AcquisitionTypeResponseDto,
  AssetImportPreviewResponseDto,
  AssetBulkResultResponseDto,
  AssetTimelineResponseDto,
)
@Feature('assets')
@Controller('assets')
export class AssetsController {
  constructor(
    private readonly assetsService: AssetsService,
    private readonly timelineService: AssetTimelineService,
  ) {}

  @Get('acquisition-types')
  @UseGuards(AssetReadScopeGuard)
  @AssetReadCatalog()
  @ApiOperation({
    summary: 'Catálogo de tipos de adquisición',
    description:
      'Catálogo sin datos de activos: basta asset:read:global o asset:read:org_unit, aunque el usuario no alcance ningún centro de costo.',
  })
  @ApiResponse({
    status: 200,
    schema: envelopedSchema(AcquisitionTypeResponseDto),
  })
  @ApiResponse({
    status: 403,
    description: 'INSUFFICIENT_PERMISSIONS: no tiene asset:read:global ni asset:read:org_unit.',
    schema: errorEnvelopeSchema(),
  })
  acquisitionTypes(): Promise<ReadonlyArray<AcquisitionTypeResponseDto>> {
    return this.assetsService.listAcquisitionTypes();
  }

  @Get()
  @UseGuards(AssetReadScopeGuard)
  @ApiOperation({
    summary: 'Listar activos',
    description: `${READ_SCOPE_DESCRIPTION} El alcance se aplica en la consulta: total, hasNext y la paginación son del conjunto visible. Filtrar por un costCenterId fuera de alcance devuelve una lista vacía.`,
  })
  @ApiResponse({ status: 200, schema: envelopedSchema(AssetListResponseDto) })
  @ApiResponse(READ_FORBIDDEN_RESPONSE)
  list(
    @Query() query: QueryAssetsDto,
    @AssetReadScope() scope: ReadableCostCenterScope,
  ): Promise<AssetListResponseDto> {
    return this.assetsService.list(query, scope);
  }

  @Get(':id/timeline')
  @UseGuards(AssetReadScopeGuard)
  @ApiOperation({
    summary: 'Historia del activo',
    description: `Compra, movimientos, documentos generados, fotos y tomas físicas en orden cronológico. Cada evento trae documentId cuando tiene documento, descargable en GET /documents/:id/pdf. ${READ_SCOPE_DESCRIPTION}`,
  })
  @ApiResponse({ status: 200, schema: envelopedSchema(AssetTimelineResponseDto) })
  @ApiResponse(READ_FORBIDDEN_RESPONSE)
  @ApiResponse(NOT_FOUND_RESPONSE)
  timeline(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query() query: QueryTimelineDto,
    @AssetReadScope() scope: ReadableCostCenterScope,
  ): Promise<AssetTimelineResponseDto> {
    return this.timelineService.timeline(
      id,
      {
        page: query.page,
        pageSize: query.pageSize,
        order: query.order,
      },
      scope,
    );
  }

  @Get(':id')
  @UseGuards(AssetReadScopeGuard)
  @ApiOperation({ summary: 'Detalle de activo', description: READ_SCOPE_DESCRIPTION })
  @ApiResponse({ status: 200, schema: envelopedSchema(AssetResponseDto) })
  @ApiResponse(READ_FORBIDDEN_RESPONSE)
  @ApiResponse(NOT_FOUND_RESPONSE)
  getById(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @AssetReadScope() scope: ReadableCostCenterScope,
  ): Promise<AssetResponseDto> {
    return this.assetsService.getById(id, scope);
  }

  @Post()
  @RequirePermission('asset:create:global')
  @ApiOperation({ summary: 'Registrar activo' })
  @ApiResponse({ status: 201, schema: envelopedSchema(AssetResponseDto) })
  create(
    @Body() dto: CreateAssetDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AssetResponseDto> {
    return this.assetsService.create(dto, user);
  }

  @Post('bulk')
  @RequirePermission('asset:create:global')
  @ApiOperation({ summary: 'Alta masiva JSON' })
  @ApiResponse({
    status: 201,
    schema: envelopedSchema(AssetBulkResultResponseDto),
  })
  bulk(
    @Body() dto: BulkCreateAssetsDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AssetBulkResultResponseDto> {
    return this.assetsService.bulkCreate(
      dto.items,
      dto.mode ?? ImportMode.AllOrNothing,
      user,
    );
  }

  @Post('import')
  @RequirePermission('asset:create:global')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiOperation({
    summary: 'Previsualizar importación CSV',
    description:
      'Columnas: description, category_code, cost_center_code, acquisition_type_code, acquisition_date. Opcionales: internal_code, location_code, serial_number, barcode, model, photo_url, notes, acquisition_price y códigos de campos dinámicos.',
  })
  previewImport(
    @UploadedFile() file: CsvUpload | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AssetImportPreviewResponseDto> {
    if (!file) {
      throw new ApiException(ErrorCode.InvalidCsv);
    }
    return this.assetsService.previewImport(
      file.buffer.toString('utf8'),
      file.originalname,
      user,
    );
  }

  @Post('import/commit')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('asset:create:global')
  @ApiOperation({ summary: 'Confirmar importación CSV' })
  commitImport(
    @Body() dto: CommitAssetImportDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AssetBulkResultResponseDto> {
    return this.assetsService.commitImport(
      dto.previewId,
      dto.mode ?? ImportMode.AllOrNothing,
      user,
    );
  }

  @Patch(':id')
  @RequirePermission('asset:update:global')
  @ApiOperation({
    summary: 'Actualizar activo',
    description: 'internalCode no es editable. Para centro de costo usar reassign-cost-center.',
  })
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateAssetDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AssetResponseDto> {
    return this.assetsService.update(id, dto, user);
  }

  @Post(':id/change-status')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('asset:update:global')
  @ApiOperation({ summary: 'Cambiar estado operacional' })
  changeStatus(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ChangeAssetStatusDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AssetResponseDto> {
    return this.assetsService.changeStatus(
      id,
      dto.operationalStatus,
      dto.reason,
      user,
    );
  }

  @Post(':id/write-off')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('asset:write_off:global')
  @ApiOperation({ summary: 'Dar de baja definitiva' })
  writeOff(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: WriteOffAssetDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AssetResponseDto> {
    return this.assetsService.writeOff(id, dto, user);
  }

  @Post(':id/reassign-location')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('asset:update:global')
  @ApiOperation({ summary: 'Cambiar ubicación física' })
  reassignLocation(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ReassignLocationDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AssetResponseDto> {
    return this.assetsService.reassignLocation(
      id,
      dto.locationId,
      dto.reason,
      user,
    );
  }

  @Post(':id/reassign-cost-center')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('asset:update:global')
  @ApiOperation({
    summary: 'Cambiar centro de costo',
    description: 'Requiere documentReference (acta/oficio). Bloqueado si hay préstamo activo.',
  })
  reassignCostCenter(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ReassignCostCenterDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AssetResponseDto> {
    return this.assetsService.reassignCostCenter(
      id,
      dto.costCenterId,
      dto.documentReference,
      dto.reason,
      user,
    );
  }
}
