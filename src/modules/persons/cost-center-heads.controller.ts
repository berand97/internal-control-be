import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiExtraModels, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Feature } from '../../common/decorators/feature.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { ApiSuccessEnvelope, envelopedSchema } from '../../common/swagger/api-envelopes.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';
import { envelopedArraySchema } from '../documents/dto/document.responses.js';
import {
  AssignCostCenterHeadDto,
  CostCenterHeadDto,
  EndCostCenterHeadDto,
  QueryCostCenterHeadsDto,
} from './dto/cost-center-head.dto.js';
import { COST_CENTER_HEAD_PERMISSION, CostCenterHeadsService } from './services/cost-center-heads.service.js';

const SCOPE_NOTE =
  'Una jefatura vigente amplía el alcance de lectura de quien tenga un rol con el permiso acotado (asset:read:org_unit, y en préstamos loan:approve:org_unit): ve los centros de sus asignaciones COST_CENTER más los que dirige. No da permisos por sí sola. Varias personas pueden dirigir el mismo centro.';

@ApiTags(OpenApiTag.CostCenters)
@ApiBearerAuth()
@ApiExtraModels(ApiSuccessEnvelope, CostCenterHeadDto)
@Feature('cost-centers')
@Controller()
export class CostCenterHeadsController {
  constructor(private readonly heads: CostCenterHeadsService) {}

  @Post('cost-center-heads')
  @RequirePermission(COST_CENTER_HEAD_PERMISSION)
  @ApiOperation({ summary: 'Asignar a una persona como jefe de un centro de costo', description: SCOPE_NOTE })
  @ApiCreatedResponse({ schema: envelopedSchema(CostCenterHeadDto) })
  assign(@Body() dto: AssignCostCenterHeadDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.heads.assign(dto, actor);
  }

  @Post('cost-center-heads/:id/end')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(COST_CENTER_HEAD_PERMISSION)
  @ApiOperation({
    summary: 'Terminar una jefatura',
    description: 'La jefatura deja de estar vigente ahora (una que aún no empezaba queda sin vigencia). 409 COST_CENTER_HEAD_ENDED si ya había terminado.',
  })
  @ApiOkResponse({ schema: envelopedSchema(CostCenterHeadDto) })
  end(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EndCostCenterHeadDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.heads.end(id, dto.reason, actor);
  }

  @Get('cost-centers/:costCenterId/heads')
  @RequirePermission(COST_CENTER_HEAD_PERMISSION)
  @ApiOperation({ summary: 'Jefes de un centro de costo (vigentes o historial)' })
  @ApiOkResponse({ schema: envelopedArraySchema(CostCenterHeadDto) })
  byCostCenter(
    @Param('costCenterId', ParseUUIDPipe) costCenterId: string,
    @Query() query: QueryCostCenterHeadsDto,
  ) {
    return this.heads.byCostCenter(costCenterId, query.current ?? false);
  }

  @Get('persons/:personId/cost-center-headships')
  @RequirePermission(COST_CENTER_HEAD_PERMISSION)
  @ApiOperation({ summary: 'Centros de costo que dirige una persona (vigentes o historial)' })
  @ApiOkResponse({ schema: envelopedArraySchema(CostCenterHeadDto) })
  byPerson(@Param('personId', ParseUUIDPipe) personId: string, @Query() query: QueryCostCenterHeadsDto) {
    return this.heads.byPerson(personId, query.current ?? false);
  }
}
