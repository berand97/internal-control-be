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
import { Feature } from '../../common/decorators/feature.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import {
  ApiErrorEnvelope,
  ApiSuccessEnvelope,
  envelopedSchema,
  errorEnvelopeSchema,
} from '../../common/swagger/api-envelopes.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import {
  CreatePermissionDto,
  UpdatePermissionDto,
} from './dto/create-permission.dto.js';
import { NavigationCatalogItemResponseDto } from './dto/responses/navigation-catalog-item.response.dto.js';
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
  NavigationCatalogItemResponseDto,
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

  @Get('navigation-catalog')
  @RequirePermission('role:read:global')
  @ApiOperation({
    summary: 'Catálogo de menús derivado de permisos',
    description:
      'No se asignan menús a mano. Al marcar un permiso en el rol, el usuario que lo reciba verá el ítem correspondiente en /auth/me.',
  })
  @ApiResponse({
    status: 200,
    schema: envelopedSchema(NavigationCatalogItemResponseDto),
  })
  navigationCatalog(): Promise<ReadonlyArray<NavigationCatalogItemResponseDto>> {
    return this.rolesService.listNavigationCatalog();
  }

  @Get()
  @RequirePermission('role:read:global')
  @ApiOperation({ summary: 'Listado plano de permisos disponibles' })
  @ApiResponse({ status: 200, schema: envelopedSchema(PermissionResponseDto) })
  list(): Promise<ReadonlyArray<PermissionResponseDto>> {
    return this.rolesService.listPermissions();
  }

  @Post()
  @RequirePermission('role:manage:global')
  @ApiOperation({
    summary: 'Crear permiso de catálogo',
    description:
      'El código se arma como resource:action:scope. Luego se asigna a roles desde la matriz.',
  })
  @ApiResponse({ status: 201, schema: envelopedSchema(PermissionResponseDto) })
  create(
    @Body() dto: CreatePermissionDto,
  ): Promise<PermissionResponseDto> {
    return this.rolesService.createPermission(dto);
  }

  @Patch(':id')
  @RequirePermission('role:manage:global')
  @ApiOperation({ summary: 'Actualizar descripción de un permiso' })
  @ApiResponse({ status: 200, schema: envelopedSchema(PermissionResponseDto) })
  @ApiResponse({ status: 404, schema: errorEnvelopeSchema() })
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdatePermissionDto,
  ): Promise<PermissionResponseDto> {
    return this.rolesService.updatePermission(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('role:manage:global')
  @ApiOperation({ summary: 'Eliminar un permiso custom sin asignaciones' })
  @ApiResponse({ status: 200, schema: { $ref: getSchemaPath(ApiSuccessEnvelope) } })
  remove(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<null> {
    return this.rolesService.deletePermission(id);
  }
}
