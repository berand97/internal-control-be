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
import { BulkCreateAssetsDto } from './dto/bulk-create-assets.dto.js';
import { ChangeAssetStatusDto } from './dto/change-asset-status.dto.js';
import { CommitAssetImportDto } from './dto/commit-asset-import.dto.js';
import { CreateAssetDto } from './dto/create-asset.dto.js';
import { QueryAssetsDto } from './dto/query-assets.dto.js';
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
import { AssetsService } from './services/assets.service.js';

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
)
@Feature('assets')
@Controller('assets')
export class AssetsController {
  constructor(private readonly assetsService: AssetsService) {}

  @Get('acquisition-types')
  @RequirePermission('asset:read:global')
  @ApiOperation({ summary: 'Catálogo de tipos de adquisición' })
  @ApiResponse({
    status: 200,
    schema: envelopedSchema(AcquisitionTypeResponseDto),
  })
  acquisitionTypes(): Promise<ReadonlyArray<AcquisitionTypeResponseDto>> {
    return this.assetsService.listAcquisitionTypes();
  }

  @Get()
  @RequirePermission('asset:read:global')
  @ApiOperation({ summary: 'Listar activos' })
  @ApiResponse({ status: 200, schema: envelopedSchema(AssetListResponseDto) })
  list(@Query() query: QueryAssetsDto): Promise<AssetListResponseDto> {
    return this.assetsService.list(query);
  }

  @Get(':id')
  @RequirePermission('asset:read:global')
  @ApiOperation({ summary: 'Detalle de activo' })
  @ApiResponse({ status: 200, schema: envelopedSchema(AssetResponseDto) })
  @ApiResponse({ status: 404, schema: errorEnvelopeSchema() })
  getById(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<AssetResponseDto> {
    return this.assetsService.getById(id);
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
