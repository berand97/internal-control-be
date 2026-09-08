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
import { CreateLocationDto } from './dto/create-location.dto.js';
import { QueryLocationsDto } from './dto/query-locations.dto.js';
import { LocationResponseDto } from './dto/responses/location.response.dto.js';
import { UpdateLocationDto } from './dto/update-location.dto.js';
import { LocationsService } from './services/locations.service.js';

@ApiTags(OpenApiTag.Locations)
@ApiBearerAuth()
@ApiExtraModels(ApiSuccessEnvelope, ApiErrorEnvelope, LocationResponseDto)
@Feature('locations')
@Controller()
export class LocationsController {
  constructor(private readonly locationsService: LocationsService) {}

  @Get('locations')
  @RequirePermission('location:read:global')
  @ApiOperation({ summary: 'Buscar ubicaciones' })
  @ApiResponse({ status: 200, schema: envelopedSchema(LocationResponseDto) })
  search(
    @Query() query: QueryLocationsDto,
  ): Promise<ReadonlyArray<LocationResponseDto>> {
    return this.locationsService.search(query);
  }

  @Get('buildings/:buildingId/locations')
  @RequirePermission('location:read:global')
  @ApiOperation({ summary: 'Listar ubicaciones de un edificio' })
  @ApiResponse({ status: 200, schema: envelopedSchema(LocationResponseDto) })
  listByBuilding(
    @Param('buildingId', new ParseUUIDPipe({ version: '4' }))
    buildingId: string,
  ): Promise<ReadonlyArray<LocationResponseDto>> {
    return this.locationsService.listByBuilding(buildingId);
  }

  @Get('buildings/:buildingId/locations/:id')
  @RequirePermission('location:read:global')
  @ApiOperation({ summary: 'Detalle de ubicación' })
  @ApiResponse({ status: 200, schema: envelopedSchema(LocationResponseDto) })
  @ApiResponse({ status: 404, schema: errorEnvelopeSchema() })
  getById(
    @Param('buildingId', new ParseUUIDPipe({ version: '4' }))
    buildingId: string,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<LocationResponseDto> {
    return this.locationsService.getById(buildingId, id);
  }

  @Post('buildings/:buildingId/locations')
  @RequirePermission('location:manage:global')
  @ApiOperation({ summary: 'Crear ubicación en un edificio' })
  @ApiResponse({ status: 201, schema: envelopedSchema(LocationResponseDto) })
  create(
    @Param('buildingId', new ParseUUIDPipe({ version: '4' }))
    buildingId: string,
    @Body() dto: CreateLocationDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<LocationResponseDto> {
    return this.locationsService.create(buildingId, dto, user);
  }

  @Patch('buildings/:buildingId/locations/:id')
  @RequirePermission('location:manage:global')
  @ApiOperation({ summary: 'Actualizar ubicación' })
  @ApiResponse({ status: 200, schema: envelopedSchema(LocationResponseDto) })
  update(
    @Param('buildingId', new ParseUUIDPipe({ version: '4' }))
    buildingId: string,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateLocationDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<LocationResponseDto> {
    return this.locationsService.update(buildingId, id, dto, user);
  }

  @Delete('buildings/:buildingId/locations/:id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('location:manage:global')
  @ApiOperation({ summary: 'Desactivar ubicación (soft delete)' })
  @ApiResponse({
    status: 200,
    schema: { $ref: getSchemaPath(ApiSuccessEnvelope) },
  })
  remove(
    @Param('buildingId', new ParseUUIDPipe({ version: '4' }))
    buildingId: string,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<null> {
    return this.locationsService.remove(buildingId, id, user);
  }
}
