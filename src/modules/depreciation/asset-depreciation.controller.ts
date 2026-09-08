import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Feature } from '../../common/decorators/feature.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import { DepreciationService } from './services/depreciation.service.js';

@ApiTags(OpenApiTag.Depreciation)
@ApiBearerAuth()
@Feature('depreciation')
@Controller('assets')
export class AssetDepreciationController {
  constructor(private readonly depreciationService: DepreciationService) {}

  @Get(':id/depreciation-history')
  @RequirePermission('depreciation:read:global')
  @ApiOperation({ summary: 'Histórico de depreciación de un activo' })
  history(@Param('id', ParseUUIDPipe) id: string) {
    return this.depreciationService.history(id);
  }
}
