import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiExtraModels, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Feature } from '../../common/decorators/feature.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { envelopedSchema } from '../../common/swagger/api-envelopes.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';
import { envelopedArraySchema } from '../documents/dto/document.responses.js';
import { CreateAccountingCutDto } from './dto/inventory-reconciliation.dto.js';
import { AccountingCutDto } from './dto/inventory.responses.js';
import { AccountingCutsService } from './services/accounting-cuts.service.js';

@ApiTags(OpenApiTag.Inventories)
@ApiBearerAuth()
@ApiExtraModels(AccountingCutDto)
@Feature('inventories')
@Controller('accounting-cuts')
export class AccountingCutsController {
  constructor(private readonly cuts: AccountingCutsService) {}

  @Get()
  @RequirePermission('inventory:read:global')
  @ApiOperation({ summary: 'Cortes contables, el más reciente primero' })
  @ApiOkResponse({ schema: envelopedArraySchema(AccountingCutDto) })
  list() {
    return this.cuts.list();
  }

  @Get(':id')
  @RequirePermission('inventory:read:global')
  @ApiOperation({ summary: 'Un corte contable' })
  @ApiOkResponse({ schema: envelopedSchema(AccountingCutDto) })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.cuts.get(id);
  }

  @Post()
  @RequirePermission('inventory:create:global')
  @ApiOperation({
    summary: 'Registrar un corte contable (fecha y fuente)',
    description:
      'Corte MANUAL: fija la fecha de valoración y la fuente que muestra la toma. Las líneas con el valor en libros de ' +
      'cada activo llegarán por el importador cuando Contabilidad defina las columnas de su reporte.',
  })
  @ApiCreatedResponse({ schema: envelopedSchema(AccountingCutDto) })
  create(@Body() dto: CreateAccountingCutDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.cuts.create(dto, actor);
  }
}
