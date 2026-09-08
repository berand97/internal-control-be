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
import { CreateBuildingDto } from './dto/create-building.dto.js';
import { BuildingResponseDto } from './dto/responses/building.response.dto.js';
import { UpdateBuildingDto } from './dto/update-building.dto.js';
import { BuildingsService } from './services/buildings.service.js';

@ApiTags(OpenApiTag.Buildings)
@ApiBearerAuth()
@ApiExtraModels(ApiSuccessEnvelope, ApiErrorEnvelope, BuildingResponseDto)
@Feature('buildings')
@Controller('campus/:campusId/buildings')
export class BuildingsController {
  constructor(private readonly buildingsService: BuildingsService) {}

  @Get()
  @RequirePermission('building:read:global')
  @ApiOperation({ summary: 'Listar edificios de un campus' })
  @ApiResponse({ status: 200, schema: envelopedSchema(BuildingResponseDto) })
  list(
    @Param('campusId', new ParseUUIDPipe({ version: '4' })) campusId: string,
  ): Promise<ReadonlyArray<BuildingResponseDto>> {
    return this.buildingsService.list(campusId);
  }

  @Get(':id')
  @RequirePermission('building:read:global')
  @ApiOperation({ summary: 'Detalle de edificio' })
  @ApiResponse({ status: 200, schema: envelopedSchema(BuildingResponseDto) })
  @ApiResponse({ status: 404, schema: errorEnvelopeSchema() })
  getById(
    @Param('campusId', new ParseUUIDPipe({ version: '4' })) campusId: string,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<BuildingResponseDto> {
    return this.buildingsService.getById(campusId, id);
  }

  @Post()
  @RequirePermission('building:manage:global')
  @ApiOperation({ summary: 'Crear edificio en un campus' })
  @ApiResponse({ status: 201, schema: envelopedSchema(BuildingResponseDto) })
  create(
    @Param('campusId', new ParseUUIDPipe({ version: '4' })) campusId: string,
    @Body() dto: CreateBuildingDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BuildingResponseDto> {
    return this.buildingsService.create(campusId, dto, user);
  }

  @Patch(':id')
  @RequirePermission('building:manage:global')
  @ApiOperation({ summary: 'Actualizar edificio' })
  @ApiResponse({ status: 200, schema: envelopedSchema(BuildingResponseDto) })
  update(
    @Param('campusId', new ParseUUIDPipe({ version: '4' })) campusId: string,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateBuildingDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BuildingResponseDto> {
    return this.buildingsService.update(campusId, id, dto, user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('building:manage:global')
  @ApiOperation({ summary: 'Desactivar edificio (soft delete)' })
  @ApiResponse({
    status: 200,
    schema: { $ref: getSchemaPath(ApiSuccessEnvelope) },
  })
  remove(
    @Param('campusId', new ParseUUIDPipe({ version: '4' })) campusId: string,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<null> {
    return this.buildingsService.remove(campusId, id, user);
  }
}
