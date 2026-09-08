import { Controller, Get } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Feature } from '../../common/decorators/feature.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import {
  ApiErrorEnvelope,
  ApiSuccessEnvelope,
  envelopedSchema,
} from '../../common/swagger/api-envelopes.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import {
  PermissionCatalogModuleDto,
} from './dto/responses/permission-catalog.response.dto.js';
import { PermissionResponseDto } from './dto/responses/permission.response.dto.js';
import { RolesService } from './services/roles.service.js';

@ApiTags(OpenApiTag.Permissions)
@ApiBearerAuth()
@ApiExtraModels(
  ApiSuccessEnvelope,
  ApiErrorEnvelope,
  PermissionResponseDto,
  PermissionCatalogModuleDto,
)
@Feature('roles')
@Controller('permissions')
export class PermissionsController {
  constructor(private readonly rolesService: RolesService) {}

  @Get('catalog')
  @RequirePermission('role:read:global')
  @ApiOperation({
    summary: 'Catálogo de permisos agrupado por módulo y recurso',
    description:
      'Para armar la matriz de roles sin quemar códigos. El frontend pinta módulos/recursos/acciones que vengan aquí.',
  })
  @ApiResponse({
    status: 200,
    schema: envelopedSchema(PermissionCatalogModuleDto),
  })
  catalog(): Promise<ReadonlyArray<PermissionCatalogModuleDto>> {
    return this.rolesService.listPermissionCatalog();
  }

  @Get()
  @RequirePermission('role:read:global')
  @ApiOperation({ summary: 'Listado plano de permisos disponibles' })
  @ApiResponse({ status: 200, schema: envelopedSchema(PermissionResponseDto) })
  list(): Promise<ReadonlyArray<PermissionResponseDto>> {
    return this.rolesService.listPermissions();
  }
}
