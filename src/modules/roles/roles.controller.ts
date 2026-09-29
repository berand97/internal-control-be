import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
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
import { requestOrigin } from '../../common/types/request-origin.type.js';
import {
  AssignPermissionsDto,
  RemovePermissionDto,
  ReplacePermissionsDto,
} from './dto/assign-permissions.dto.js';
import { CreateRoleDto } from './dto/create-role.dto.js';
import { CreateSodRuleDto } from './dto/create-sod-rule.dto.js';
import { UpdateRoleDto } from './dto/update-role.dto.js';
import { RoleDetailResponseDto } from './dto/responses/role-detail.response.dto.js';
import { RoleResponseDto } from './dto/responses/role.response.dto.js';
import { SodRuleResponseDto } from './dto/responses/sod-rule.response.dto.js';
import {
  QueryRoleGrantsHistoryDto,
  RoleGrantsHistoryPageDto,
} from './dto/role-grants-history.dto.js';
import { RoleGrantsHistoryService } from './services/role-grants-history.service.js';
import { RolesService } from './services/roles.service.js';

@ApiTags(OpenApiTag.Roles)
@ApiBearerAuth()
@ApiExtraModels(
  ApiSuccessEnvelope,
  ApiErrorEnvelope,
  RoleResponseDto,
  RoleDetailResponseDto,
  SodRuleResponseDto,
  RoleGrantsHistoryPageDto,
)
@Feature('roles')
@Controller('roles')
export class RolesController {
  constructor(
    private readonly rolesService: RolesService,
    private readonly grantsHistory: RoleGrantsHistoryService,
  ) {}

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

  @Get('grants-history')
  @RequirePermission('role:audit:global')
  @ApiOperation({
    summary: 'Historial de permisos y roles otorgados o retirados',
    description:
      'Quién, cuándo, desde dónde (IP y user-agent), qué permisos agregó o quitó a qué rol, qué rol dio o quitó a qué usuario (con alcance y vigencia) y el motivo. Incluye creación, edición y borrado de roles. Solo lectura: requiere role:audit:global (de base: Directora de Control Interno y SUPER_ADMIN), no administración de roles. Registros anteriores a que se exigiera el motivo traen reason, ipAddress y userAgent en null. Filtros combinables; orden del más reciente al más antiguo.',
  })
  @ApiResponse({ status: 200, schema: envelopedSchema(RoleGrantsHistoryPageDto) })
  @ApiResponse({ status: 400, description: 'Filtro inválido (VALIDATION_FAILED)', schema: errorEnvelopeSchema() })
  grantsHistoryList(@Query() query: QueryRoleGrantsHistoryDto): Promise<RoleGrantsHistoryPageDto> {
    return this.grantsHistory.list(query);
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
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<RoleResponseDto> {
    return this.rolesService.create(dto, user, requestOrigin(ipAddress, userAgent));
  }

  @Patch(':id')
  @RequirePermission('role:manage:global')
  @ApiOperation({ summary: 'Actualizar rol' })
  @ApiResponse({ status: 200, schema: envelopedSchema(RoleResponseDto) })
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateRoleDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<RoleResponseDto> {
    return this.rolesService.update(id, dto, user, requestOrigin(ipAddress, userAgent));
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
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<RoleDetailResponseDto> {
    return this.rolesService.assignPermissions(id, dto, user, requestOrigin(ipAddress, userAgent));
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
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<RoleDetailResponseDto> {
    return this.rolesService.replacePermissions(id, dto, user, requestOrigin(ipAddress, userAgent));
  }

  @Delete(':id/permissions/:permissionId')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('role:manage:global')
  @ApiOperation({
    summary: 'Remover un permiso del rol',
    description: 'El cuerpo lleva el motivo obligatorio del retiro ({ reason }), que queda en la bitácora.',
  })
  @ApiResponse({
    status: 200,
    schema: { $ref: getSchemaPath(ApiSuccessEnvelope) },
  })
  removePermission(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('permissionId', new ParseUUIDPipe({ version: '4' }))
    permissionId: string,
    @Body() dto: RemovePermissionDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<null> {
    return this.rolesService.removePermission(id, permissionId, dto, user, requestOrigin(ipAddress, userAgent));
  }

}
