import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Feature } from '../../common/decorators/feature.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import {
  ApiErrorEnvelope,
  ApiSuccessEnvelope,
} from '../../common/swagger/api-envelopes.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';
import {
  CalculateDepreciationDto,
  DepreciationSummaryQueryDto,
  QueryDepreciationDto,
} from './dto/depreciation.dto.js';
import { DepreciationService } from './services/depreciation.service.js';

@ApiTags(OpenApiTag.Depreciation)
@ApiBearerAuth()
@ApiExtraModels(ApiSuccessEnvelope, ApiErrorEnvelope)
@Feature('depreciation')
@Controller('depreciation')
export class DepreciationController {
  constructor(private readonly depreciationService: DepreciationService) {}

  @Get('summary')
  @RequirePermission('depreciation:read:global')
  @ApiOperation({ summary: 'Totales de depreciación por centro y categoría' })
  summary(@Query() query: DepreciationSummaryQueryDto) {
    return this.depreciationService.summary(query.year, query.month);
  }

  @Get()
  @RequirePermission('depreciation:read:global')
  @ApiOperation({ summary: 'Consultar snapshots de depreciación' })
  list(@Query() query: QueryDepreciationDto) {
    return this.depreciationService.list(query);
  }

  @Post('calculate')
  @RequirePermission('depreciation:calculate:global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Calcular (o regenerar) el snapshot de un período',
  })
  calculate(
    @Body() dto: CalculateDepreciationDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.depreciationService.calculate(dto, actor);
  }
}
