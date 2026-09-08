import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Feature } from '../../common/decorators/feature.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import {
  ApiErrorEnvelope,
  ApiSuccessEnvelope,
} from '../../common/swagger/api-envelopes.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import { FeatureResponseDto } from './dto/feature.response.dto.js';
import { UpdateFeatureDto } from './dto/update-feature.dto.js';
import { FeatureFlagsService } from './services/feature-flags.service.js';

@ApiTags(OpenApiTag.Features)
@ApiBearerAuth()
@ApiExtraModels(ApiSuccessEnvelope, ApiErrorEnvelope, FeatureResponseDto)
@Feature('features')
@Controller('features')
export class FeaturesController {
  constructor(private readonly featureFlags: FeatureFlagsService) {}

  @Get()
  @ApiOperation({
    summary: 'Listar módulos y su estado',
    description:
      'Cualquier usuario autenticado. El frontend oculta navegación y botones de los módulos con enabled=false. No mostrar toast si llega MODULE_UNAVAILABLE.',
  })
  list(): ReadonlyArray<FeatureResponseDto> {
    return this.featureFlags.list().map(FeatureResponseDto.from);
  }

  @Patch(':code')
  @RequirePermission('feature:manage:global')
  @ApiOperation({
    summary: 'Activar o desactivar un módulo',
    description:
      'No aplica a módulos core ni a flags fijados por FEATURE_<CODE> en entorno.',
  })
  async update(
    @Param('code') code: string,
    @Body() dto: UpdateFeatureDto,
  ): Promise<FeatureResponseDto> {
    const feature = await this.featureFlags.setEnabled(code, dto.enabled);
    return FeatureResponseDto.from(feature);
  }
}
