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
import { AssignUserRoleDto } from './dto/assign-user-role.dto.js';
import { CreateUserDto } from './dto/create-user.dto.js';
import { DelegateUserRoleDto } from './dto/delegate-user-role.dto.js';
import { QueryUsersDto } from './dto/query-users.dto.js';
import { UpdateUserDto } from './dto/update-user.dto.js';
import { UserDetailResponseDto } from './dto/responses/user-detail.response.dto.js';
import { UserRoleResponseDto } from './dto/responses/user-role.response.dto.js';
import { UsersPageResponseDto } from './dto/responses/users-page.response.dto.js';
import { UsersService } from './services/users.service.js';

@ApiTags(OpenApiTag.Users)
@ApiBearerAuth()
@ApiExtraModels(
  ApiSuccessEnvelope,
  ApiErrorEnvelope,
  UserDetailResponseDto,
  UsersPageResponseDto,
  UserRoleResponseDto,
)
@Feature('users')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @RequirePermission('user:read:global')
  @ApiOperation({ summary: 'Listar usuarios paginados' })
  @ApiResponse({ status: 200, schema: envelopedSchema(UsersPageResponseDto) })
  async list(@Query() query: QueryUsersDto): Promise<UsersPageResponseDto> {
    const result = await this.usersService.list(query);
    return UsersPageResponseDto.from(result);
  }

  @Get(':id')
  @RequirePermission('user:read:global')
  @ApiOperation({ summary: 'Detalle de usuario con roles activos' })
  @ApiResponse({ status: 200, schema: envelopedSchema(UserDetailResponseDto) })
  @ApiResponse({ status: 404, schema: errorEnvelopeSchema() })
  getById(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<UserDetailResponseDto> {
    return this.usersService.getById(id);
  }

  @Post()
  @RequirePermission('user:manage:global')
  @ApiOperation({
    summary: 'Crear usuario e invitarlo por correo',
    description:
      'Crea la persona y la cuenta en PENDING_ACTIVATION, genera una contraseña temporal y envía la invitación. El usuario de acceso es el correo institucional. No se devuelve la contraseña en la respuesta.',
  })
  @ApiResponse({ status: 201, schema: envelopedSchema(UserDetailResponseDto) })
  create(
    @Body() dto: CreateUserDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<UserDetailResponseDto> {
    return this.usersService.create(dto, user);
  }

  @Post(':id/resend-invitation')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('user:manage:global')
  @ApiOperation({
    summary: 'Reenviar invitación con una nueva contraseña temporal',
    description:
      'Sólo para cuentas pendientes de activación o que aún deben cambiar la contraseña temporal. Revoca sesiones previas.',
  })
  @ApiResponse({
    status: 200,
    schema: { $ref: getSchemaPath(ApiSuccessEnvelope) },
  })
  @ApiResponse({ status: 404, schema: errorEnvelopeSchema() })
  @ApiResponse({ status: 406, schema: errorEnvelopeSchema() })
  resendInvitation(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<null> {
    return this.usersService.resendInvitation(id, user);
  }

  @Patch(':id')
  @RequirePermission('user:manage:global')
  @ApiOperation({ summary: 'Actualizar datos no sensibles de la persona' })
  @ApiResponse({ status: 200, schema: envelopedSchema(UserDetailResponseDto) })
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<UserDetailResponseDto> {
    return this.usersService.update(id, dto, user);
  }

  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('user:manage:global')
  @ApiOperation({ summary: 'Desactivar usuario y revocar sesiones' })
  @ApiResponse({
    status: 200,
    schema: { $ref: getSchemaPath(ApiSuccessEnvelope) },
  })
  deactivate(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<null> {
    return this.usersService.deactivate(id, user);
  }

  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('user:manage:global')
  @ApiOperation({ summary: 'Reactivar usuario' })
  @ApiResponse({
    status: 200,
    schema: { $ref: getSchemaPath(ApiSuccessEnvelope) },
  })
  reactivate(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<null> {
    return this.usersService.reactivate(id, user);
  }

  @Post(':id/roles')
  @RequirePermission('role:assign:global')
  @ApiOperation({ summary: 'Asignar rol con scope y vigencia' })
  @ApiResponse({ status: 201, schema: envelopedSchema(UserRoleResponseDto) })
  assignRole(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: AssignUserRoleDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<UserRoleResponseDto> {
    return this.usersService.assignRole(id, dto, user);
  }

  @Delete(':id/roles/:userRoleId')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('role:assign:global')
  @ApiOperation({ summary: 'Revocar asignación de rol' })
  @ApiResponse({
    status: 200,
    schema: { $ref: getSchemaPath(ApiSuccessEnvelope) },
  })
  revokeRole(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('userRoleId', new ParseUUIDPipe({ version: '4' }))
    userRoleId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<null> {
    return this.usersService.revokeRole(id, userRoleId, user);
  }

  @Post(':id/roles/:userRoleId/delegate')
  @RequirePermission('role:assign:global')
  @ApiOperation({ summary: 'Delegar un rol activo a otro usuario' })
  @ApiResponse({ status: 201, schema: envelopedSchema(UserRoleResponseDto) })
  delegateRole(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('userRoleId', new ParseUUIDPipe({ version: '4' }))
    userRoleId: string,
    @Body() dto: DelegateUserRoleDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<UserRoleResponseDto> {
    return this.usersService.delegateRole(id, userRoleId, dto, user);
  }
}
