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
  Put,
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
import {
  AssignPermissionsDto,
  ReplacePermissionsDto,
} from './dto/assign-permissions.dto.js';
import { CreateRoleDto } from './dto/create-role.dto.js';
import { CreateSodRuleDto } from './dto/create-sod-rule.dto.js';
import { UpdateRoleDto } from './dto/update-role.dto.js';
import { RoleDetailResponseDto } from './dto/responses/role-detail.response.dto.js';
import { RoleResponseDto } from './dto/responses/role.response.dto.js';
import { SodRuleResponseDto } from './dto/responses/sod-rule.response.dto.js';
import { RolesService } from './services/roles.service.js';

@ApiTags(OpenApiTag.Roles)
@ApiBearerAuth()
@ApiExtraModels(
  ApiSuccessEnvelope,
  ApiErrorEnvelope,
  RoleResponseDto,
  RoleDetailResponseDto,
  SodRuleResponseDto,
)
@Feature('roles')
@Controller('roles')
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Post('sod-rules')
  @RequirePermission('role:manage:global')
  @ApiOperation({ summary: 'Crear regla de separación de funciones' })
  @ApiResponse({ status: 201, schema: envelopedSchema(SodRuleResponseDto) })
  createSodRule(
    @Body() dto: CreateSodRuleDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SodRuleResponseDto> {
    return this.rolesService.createSodRule(dto, user);
  }

  @Get()
  @RequirePermission('role:read:global')
  @ApiOperation({ summary: 'Listar roles activos' })
  @ApiResponse({
    status: 200,
    schema: envelopedSchema(RoleResponseDto),
  })
  list(): Promise<ReadonlyArray<RoleResponseDto>> {
    return this.rolesService.list();
  }

  @Get(':id')
  @RequirePermission('role:read:global')
  @ApiOperation({ summary: 'Detalle de rol con permisos, hijos y SoD' })
  @ApiResponse({ status: 200, schema: envelopedSchema(RoleDetailResponseDto) })
  @ApiResponse({ status: 404, schema: errorEnvelopeSchema() })
  getById(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<RoleDetailResponseDto> {
    return this.rolesService.getById(id);
  }

  @Post()
  @RequirePermission('role:create:global')
  @ApiOperation({ summary: 'Crear rol (opcionalmente con permisos iniciales)' })
  @ApiResponse({ status: 201, schema: envelopedSchema(RoleResponseDto) })
  @ApiResponse({ status: 406, schema: errorEnvelopeSchema() })
  create(
    @Body() dto: CreateRoleDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RoleResponseDto> {
    return this.rolesService.create(dto, user);
  }

  @Patch(':id')
  @RequirePermission('role:manage:global')
  @ApiOperation({ summary: 'Actualizar rol' })
  @ApiResponse({ status: 200, schema: envelopedSchema(RoleResponseDto) })
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateRoleDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RoleResponseDto> {
    return this.rolesService.update(id, dto, user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('role:manage:global')
  @ApiOperation({ summary: 'Eliminar rol (soft delete)' })
  @ApiResponse({
    status: 200,
    description: 'Rol eliminado; data es null',
    schema: { $ref: getSchemaPath(ApiSuccessEnvelope) },
  })
  remove(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<null> {
    return this.rolesService.remove(id, user);
  }

  @Post(':id/permissions')
  @RequirePermission('role:manage:global')
  @ApiOperation({
    summary: 'Agregar permisos a un rol',
    description:
      'Suma permisos al set actual. Para la matriz de administración use PUT (reemplazo completo).',
  })
  @ApiResponse({ status: 201, schema: envelopedSchema(RoleDetailResponseDto) })
  assignPermissions(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: AssignPermissionsDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RoleDetailResponseDto> {
    return this.rolesService.assignPermissions(id, dto, user);
  }

  @Put(':id/permissions')
  @RequirePermission('role:manage:global')
  @ApiOperation({
    summary: 'Reemplazar permisos de un rol',
    description:
      'Setea el set completo de permisos directos. Aplica a roles de sistema y custom. Los permisos heredados del padre no se editan aquí.',
  })
  @ApiResponse({ status: 200, schema: envelopedSchema(RoleDetailResponseDto) })
  replacePermissions(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ReplacePermissionsDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RoleDetailResponseDto> {
    return this.rolesService.replacePermissions(id, dto, user);
  }

  @Delete(':id/permissions/:permissionId')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('role:manage:global')
  @ApiOperation({ summary: 'Remover un permiso del rol' })
  @ApiResponse({
    status: 200,
    schema: { $ref: getSchemaPath(ApiSuccessEnvelope) },
  })
  removePermission(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('permissionId', new ParseUUIDPipe({ version: '4' }))
    permissionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<null> {
    return this.rolesService.removePermission(id, permissionId, user);
  }

}
