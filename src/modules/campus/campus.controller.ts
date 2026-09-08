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
import { CreateCampusDto } from './dto/create-campus.dto.js';
import { QueryCampusDto } from './dto/query-campus.dto.js';
import { CampusResponseDto } from './dto/responses/campus.response.dto.js';
import { UpdateCampusDto } from './dto/update-campus.dto.js';
import { CampusService } from './services/campus.service.js';

@ApiTags(OpenApiTag.Campus)
@ApiBearerAuth()
@ApiExtraModels(ApiSuccessEnvelope, ApiErrorEnvelope, CampusResponseDto)
@Feature('campus')
@Controller('campus')
export class CampusController {
  constructor(private readonly campusService: CampusService) {}

  @Get()
  @RequirePermission('campus:read:global')
  @ApiOperation({ summary: 'Listar campus' })
  @ApiResponse({ status: 200, schema: envelopedSchema(CampusResponseDto) })
  list(
    @Query() query: QueryCampusDto,
  ): Promise<ReadonlyArray<CampusResponseDto>> {
    return this.campusService.list(query);
  }

  @Get(':id')
  @RequirePermission('campus:read:global')
  @ApiOperation({ summary: 'Detalle de campus' })
  @ApiResponse({ status: 200, schema: envelopedSchema(CampusResponseDto) })
  @ApiResponse({ status: 404, schema: errorEnvelopeSchema() })
  getById(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<CampusResponseDto> {
    return this.campusService.getById(id);
  }

  @Post()
  @RequirePermission('campus:manage:global')
  @ApiOperation({ summary: 'Crear campus' })
  @ApiResponse({ status: 201, schema: envelopedSchema(CampusResponseDto) })
  create(
    @Body() dto: CreateCampusDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CampusResponseDto> {
    return this.campusService.create(dto, user);
  }

  @Patch(':id')
  @RequirePermission('campus:manage:global')
  @ApiOperation({ summary: 'Actualizar campus' })
  @ApiResponse({ status: 200, schema: envelopedSchema(CampusResponseDto) })
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateCampusDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CampusResponseDto> {
    return this.campusService.update(id, dto, user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('campus:manage:global')
  @ApiOperation({ summary: 'Desactivar campus (soft delete)' })
  @ApiResponse({
    status: 200,
    schema: { $ref: getSchemaPath(ApiSuccessEnvelope) },
  })
  remove(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<null> {
    return this.campusService.remove(id, user);
  }
}
