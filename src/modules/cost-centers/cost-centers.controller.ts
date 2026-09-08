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
  getSchemaPath,
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
import { CreateCostCenterDto } from './dto/create-cost-center.dto.js';
import { QueryCostCentersDto } from './dto/query-cost-centers.dto.js';
import { CostCenterSyncResponseDto } from './dto/responses/cost-center-sync.response.dto.js';
import { CostCenterResponseDto } from './dto/responses/cost-center.response.dto.js';
import { UpdateCostCenterDto } from './dto/update-cost-center.dto.js';
import {
  CostCentersService,
  type CsvUpload,
} from './services/cost-centers.service.js';

@ApiTags(OpenApiTag.CostCenters)
@ApiBearerAuth()
@ApiExtraModels(
  ApiSuccessEnvelope,
  ApiErrorEnvelope,
  CostCenterResponseDto,
  CostCenterSyncResponseDto,
)
@Feature('cost-centers')
@Controller('cost-centers')
export class CostCentersController {
  constructor(private readonly costCentersService: CostCentersService) {}

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
  @UseInterceptors(FileInterceptor('file'))
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
  @ApiOperation({ summary: 'Crear centro de costo' })
  @ApiResponse({ status: 201, schema: envelopedSchema(CostCenterResponseDto) })
  create(
    @Body() dto: CreateCostCenterDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CostCenterResponseDto> {
    return this.costCentersService.create(dto, user);
  }

  @Patch(':id')
  @RequirePermission('cost_center:manage:global')
  @ApiOperation({ summary: 'Actualizar centro de costo' })
  @ApiResponse({ status: 200, schema: envelopedSchema(CostCenterResponseDto) })
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateCostCenterDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CostCenterResponseDto> {
    return this.costCentersService.update(id, dto, user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('cost_center:manage:global')
  @ApiOperation({ summary: 'Desactivar centro de costo' })
  @ApiResponse({
    status: 200,
    schema: { $ref: getSchemaPath(ApiSuccessEnvelope) },
  })
  remove(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<null> {
    return this.costCentersService.remove(id, user);
  }
}
