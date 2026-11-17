import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Feature } from '../../common/decorators/feature.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import {
  ApiErrorEnvelope,
  ApiSuccessEnvelope,
  envelopedSchema,
} from '../../common/swagger/api-envelopes.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import { DashboardInventorySummaryDto } from './dto/inventory-metrics.responses.js';
import { InventoryMetricsService } from './services/inventory-metrics.service.js';

@ApiTags(OpenApiTag.Inventories)
@ApiBearerAuth()
@ApiExtraModels(ApiSuccessEnvelope, ApiErrorEnvelope, DashboardInventorySummaryDto)
@Feature('inventories')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly metrics: InventoryMetricsService) {}

  @Get('inventory-summary')
  @RequirePermission('inventory:read:global')
  @ApiOperation({ summary: 'Resumen de tomas para el Inicio' })
  @ApiOkResponse({ schema: envelopedSchema(DashboardInventorySummaryDto) })
  summary() {
    return this.metrics.dashboardSummary();
  }
}
