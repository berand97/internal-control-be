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
import { CreateDynamicFieldDto } from './dto/create-dynamic-field.dto.js';
import { DynamicFieldResponseDto } from './dto/responses/dynamic-field.response.dto.js';
import { UpdateDynamicFieldDto } from './dto/update-dynamic-field.dto.js';
import { DynamicFieldsService } from './services/dynamic-fields.service.js';

@ApiTags(OpenApiTag.DynamicFields)
@ApiBearerAuth()
@ApiExtraModels(ApiSuccessEnvelope, ApiErrorEnvelope, DynamicFieldResponseDto)
@Feature('dynamic-fields')
@Controller('categories/:categoryId')
export class DynamicFieldsController {
  constructor(private readonly dynamicFieldsService: DynamicFieldsService) {}

  @Get('effective-fields')
  @RequirePermission('category:read:global')
  @ApiOperation({
    summary: 'Campos efectivos (propios + heredados de ancestros)',
  })
  @ApiResponse({
    status: 200,
    schema: envelopedSchema(DynamicFieldResponseDto),
  })
  effectiveFields(
    @Param('categoryId', new ParseUUIDPipe({ version: '4' }))
    categoryId: string,
  ): Promise<ReadonlyArray<DynamicFieldResponseDto>> {
    return this.dynamicFieldsService.effectiveFields(categoryId);
  }

  @Get('dynamic-fields')
  @RequirePermission('category:read:global')
  @ApiOperation({ summary: 'Campos definidos en esta categoría' })
  @ApiResponse({
    status: 200,
    schema: envelopedSchema(DynamicFieldResponseDto),
  })
  list(
    @Param('categoryId', new ParseUUIDPipe({ version: '4' }))
    categoryId: string,
  ): Promise<ReadonlyArray<DynamicFieldResponseDto>> {
    return this.dynamicFieldsService.list(categoryId);
  }

  @Post('dynamic-fields')
  @RequirePermission('category:manage:global')
  @ApiOperation({ summary: 'Crear campo dinámico' })
  @ApiResponse({
    status: 201,
    schema: envelopedSchema(DynamicFieldResponseDto),
  })
  create(
    @Param('categoryId', new ParseUUIDPipe({ version: '4' }))
    categoryId: string,
    @Body() dto: CreateDynamicFieldDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DynamicFieldResponseDto> {
    return this.dynamicFieldsService.create(categoryId, dto, user);
  }

  @Patch('dynamic-fields/:id')
  @RequirePermission('category:manage:global')
  @ApiOperation({
    summary: 'Actualizar campo dinámico (el tipo no cambia; el código sí)',
  })
  @ApiResponse({
    status: 200,
    schema: envelopedSchema(DynamicFieldResponseDto),
  })
  update(
    @Param('categoryId', new ParseUUIDPipe({ version: '4' }))
    categoryId: string,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateDynamicFieldDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DynamicFieldResponseDto> {
    return this.dynamicFieldsService.update(categoryId, id, dto, user);
  }

  @Post('dynamic-fields/:id/deprecate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('category:manage:global')
  @ApiOperation({
    summary: 'Deprecar campo: deja de usarse en activos nuevos',
  })
  @ApiResponse({
    status: 200,
    schema: envelopedSchema(DynamicFieldResponseDto),
  })
  deprecate(
    @Param('categoryId', new ParseUUIDPipe({ version: '4' }))
    categoryId: string,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DynamicFieldResponseDto> {
    return this.dynamicFieldsService.deprecate(categoryId, id, user);
  }

  @Delete('dynamic-fields/:id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('category:manage:global')
  @ApiOperation({
    summary: 'Eliminar campo (falla si ya hay valores en activos)',
  })
  @ApiResponse({
    status: 200,
    schema: { $ref: getSchemaPath(ApiSuccessEnvelope) },
  })
  @ApiResponse({ status: 406, schema: errorEnvelopeSchema() })
  remove(
    @Param('categoryId', new ParseUUIDPipe({ version: '4' }))
    categoryId: string,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<null> {
    return this.dynamicFieldsService.remove(categoryId, id, user);
  }
}
