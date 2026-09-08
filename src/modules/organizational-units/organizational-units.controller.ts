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
import { CreateOrganizationalUnitDto } from './dto/create-organizational-unit.dto.js';
import { QueryOrganizationalUnitsDto } from './dto/query-organizational-units.dto.js';
import { OrganizationalUnitTreeResponseDto } from './dto/responses/organizational-unit-tree.response.dto.js';
import { OrganizationalUnitResponseDto } from './dto/responses/organizational-unit.response.dto.js';
import { UpdateOrganizationalUnitDto } from './dto/update-organizational-unit.dto.js';
import { OrganizationalUnitsService } from './services/organizational-units.service.js';

@ApiTags(OpenApiTag.OrganizationalUnits)
@ApiBearerAuth()
@ApiExtraModels(
  ApiSuccessEnvelope,
  ApiErrorEnvelope,
  OrganizationalUnitResponseDto,
  OrganizationalUnitTreeResponseDto,
)
@Feature('organizational-units')
@Controller('organizational-units')
export class OrganizationalUnitsController {
  constructor(
    private readonly organizationalUnitsService: OrganizationalUnitsService,
  ) {}

  @Get('tree')
  @RequirePermission('org_unit:read:global')
  @ApiOperation({ summary: 'Árbol organizacional completo' })
  @ApiResponse({
    status: 200,
    schema: envelopedSchema(OrganizationalUnitTreeResponseDto),
  })
  tree(): Promise<ReadonlyArray<OrganizationalUnitTreeResponseDto>> {
    return this.organizationalUnitsService.tree();
  }

  @Get(':id/descendants')
  @RequirePermission('org_unit:read:global')
  @ApiOperation({ summary: 'Subárbol de una unidad' })
  @ApiResponse({
    status: 200,
    schema: envelopedSchema(OrganizationalUnitTreeResponseDto),
  })
  descendants(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<ReadonlyArray<OrganizationalUnitTreeResponseDto>> {
    return this.organizationalUnitsService.descendants(id);
  }

  @Get(':id/ancestors')
  @RequirePermission('org_unit:read:global')
  @ApiOperation({ summary: 'Cadena hacia la raíz' })
  @ApiResponse({
    status: 200,
    schema: envelopedSchema(OrganizationalUnitResponseDto),
  })
  ancestors(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<ReadonlyArray<OrganizationalUnitResponseDto>> {
    return this.organizationalUnitsService.ancestors(id);
  }

  @Get()
  @RequirePermission('org_unit:read:global')
  @ApiOperation({ summary: 'Listar unidades organizacionales' })
  @ApiResponse({
    status: 200,
    schema: envelopedSchema(OrganizationalUnitResponseDto),
  })
  list(
    @Query() query: QueryOrganizationalUnitsDto,
  ): Promise<ReadonlyArray<OrganizationalUnitResponseDto>> {
    return this.organizationalUnitsService.list(query);
  }

  @Get(':id')
  @RequirePermission('org_unit:read:global')
  @ApiOperation({ summary: 'Detalle de unidad organizacional' })
  @ApiResponse({
    status: 200,
    schema: envelopedSchema(OrganizationalUnitResponseDto),
  })
  @ApiResponse({ status: 404, schema: errorEnvelopeSchema() })
  getById(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<OrganizationalUnitResponseDto> {
    return this.organizationalUnitsService.getById(id);
  }

  @Post()
  @RequirePermission('org_unit:manage:global')
  @ApiOperation({ summary: 'Crear unidad organizacional' })
  @ApiResponse({
    status: 201,
    schema: envelopedSchema(OrganizationalUnitResponseDto),
  })
  create(
    @Body() dto: CreateOrganizationalUnitDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OrganizationalUnitResponseDto> {
    return this.organizationalUnitsService.create(dto, user);
  }

  @Patch(':id')
  @RequirePermission('org_unit:manage:global')
  @ApiOperation({
    summary: 'Actualizar o mover una unidad organizacional',
    description:
      'Cambia nombre, código, tipo y/o dependencia. `parentId` con el UUID de otra unidad mueve esta y todo su subárbol. `parentId: null` la deja como raíz. No se puede colgar de un descendiente propio.',
  })
  @ApiResponse({
    status: 200,
    schema: envelopedSchema(OrganizationalUnitResponseDto),
  })
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateOrganizationalUnitDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OrganizationalUnitResponseDto> {
    return this.organizationalUnitsService.update(id, dto, user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('org_unit:manage:global')
  @ApiOperation({ summary: 'Desactivar unidad organizacional' })
  @ApiResponse({
    status: 200,
    schema: { $ref: getSchemaPath(ApiSuccessEnvelope) },
  })
  remove(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<null> {
    return this.organizationalUnitsService.remove(id, user);
  }
}
