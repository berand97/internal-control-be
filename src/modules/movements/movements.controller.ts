import {
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { Feature } from '../../common/decorators/feature.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import {
  ApiErrorEnvelope,
  ApiSuccessEnvelope,
} from '../../common/swagger/api-envelopes.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import { QueryMovementsDto } from './dto/query-movements.dto.js';
import { MovementsService } from './services/movements.service.js';

@ApiTags(OpenApiTag.Movements)
@ApiBearerAuth()
@ApiExtraModels(ApiSuccessEnvelope, ApiErrorEnvelope)
@Feature('movements')
@Controller()
export class MovementsController {
  constructor(private readonly movementsService: MovementsService) {}

  @Get('movements')
  @RequirePermission('asset:read:global')
  @ApiOperation({ summary: 'Listar movimientos de activos' })
  list(@Query() query: QueryMovementsDto) {
    return this.movementsService.list({
      page: query.page,
      pageSize: query.pageSize,
      ...(query.type ? { type: query.type } : {}),
      ...(query.fromDate ? { fromDate: query.fromDate } : {}),
      ...(query.toDate ? { toDate: query.toDate } : {}),
      ...(query.performedBy ? { performedBy: query.performedBy } : {}),
      ...(query.costCenterId ? { costCenterId: query.costCenterId } : {}),
    });
  }

  @Get('movements/:id/verify')
  @RequirePermission('asset:read:global')
  @ApiOperation({ summary: 'Verificar firma HMAC de un movimiento' })
  verify(@Param('id', ParseUUIDPipe) id: string) {
    return this.movementsService.verify(id);
  }

  @Get('assets/:assetId/movements')
  @RequirePermission('asset:read:global')
  @ApiOperation({ summary: 'Histórico de movimientos de un activo' })
  listByAsset(
    @Param('assetId', ParseUUIDPipe) assetId: string,
    @Query() query: QueryMovementsDto,
  ) {
    return this.movementsService.list({
      page: query.page,
      pageSize: query.pageSize,
      assetId,
      ...(query.type ? { type: query.type } : {}),
      ...(query.fromDate ? { fromDate: query.fromDate } : {}),
      ...(query.toDate ? { toDate: query.toDate } : {}),
    });
  }

  @Get('assets/:assetId/movements/export')
  @RequirePermission('asset:export:global')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @ApiOperation({ summary: 'Exportar movimientos de un activo a CSV' })
  async exportCsv(
    @Param('assetId', ParseUUIDPipe) assetId: string,
    @Res() response: Response,
  ): Promise<void> {
    const csv = await this.movementsService.exportCsv(assetId);
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="movimientos-${assetId}.csv"`,
    );
    response.send(csv);
  }
}
