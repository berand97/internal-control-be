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
import { AssignUserRoleDto } from './dto/assign-user-role.dto.js';
import { CreateUserDto } from './dto/create-user.dto.js';
import { DelegateUserRoleDto } from './dto/delegate-user-role.dto.js';
import { RevokeUserRoleDto } from './dto/revoke-user-role.dto.js';
import { QueryUsersDto } from './dto/query-users.dto.js';
import { ResetUserMfaDto } from './dto/reset-user-mfa.dto.js';
import { UpdateUserDto } from './dto/update-user.dto.js';
import { UserAffiliationOptionsResponseDto } from './dto/responses/user-affiliation-options.response.dto.js';
import { UserDetailResponseDto } from './dto/responses/user-detail.response.dto.js';
import { UserMfaResetResponseDto } from './dto/responses/user-mfa-reset.response.dto.js';
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
  UserAffiliationOptionsResponseDto,
  UserMfaResetResponseDto,
)
@Feature('users')
@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
  ) {}

  @Get()
  @RequirePermission('user:read:global')
  @ApiOperation({ summary: 'Listar usuarios paginados' })
  @ApiResponse({ status: 200, schema: envelopedSchema(UsersPageResponseDto) })
  async list(@Query() query: QueryUsersDto): Promise<UsersPageResponseDto> {
    const result = await this.usersService.list(query);
    return UsersPageResponseDto.from(result);
  }

  @Get('affiliation-options')
  @RequirePermission('user:manage:global')
  @ApiOperation({
    summary: 'Departamentos, centros y roles asignables para crear un usuario',
  })
  @ApiResponse({
    status: 200,
    schema: envelopedSchema(UserAffiliationOptionsResponseDto),
  })
  affiliationOptions(
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<UserAffiliationOptionsResponseDto> {
    return this.usersService.affiliationOptions(actor);
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
      'Crea la persona y la cuenta en PENDING_ACTIVATION, genera una contraseña temporal y envía la invitación. El usuario de acceso es el correo institucional. No se devuelve la contraseña en la respuesta. La contraseña temporal vence a las 72 horas (después, el login responde 403 INVITATION_EXPIRED y hay que reenviar la invitación).',
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
      'Sólo para cuentas pendientes de activación o que aún deben cambiar la contraseña temporal. Revoca sesiones previas. La nueva contraseña temporal vence a las 72 horas.',
  })
  @ApiResponse({
    status: 200,
    schema: { $ref: getSchemaPath(ApiSuccessEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'El actor no puede administrar a ese usuario: su rol de mayor rango no está por debajo del rango del actor (ROLE_PRIVILEGE_ESCALATION). SUPER_ADMIN administra a todos.',
    schema: errorEnvelopeSchema(),
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
  @ApiResponse({
    status: 403,
    description: 'El actor no puede administrar a ese usuario: su rol de mayor rango no está por debajo del rango del actor (ROLE_PRIVILEGE_ESCALATION). SUPER_ADMIN administra a todos.',
    schema: errorEnvelopeSchema(),
  })
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
  @ApiOperation({
    summary: 'Desactivar usuario y revocar sesiones',
    description:
      'Revoca todas sus sesiones: sus access tokens dejan de servir de inmediato (401 SESSION_REVOKED).',
  })
  @ApiResponse({
    status: 200,
    schema: { $ref: getSchemaPath(ApiSuccessEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'El actor no puede administrar a ese usuario: su rol de mayor rango no está por debajo del rango del actor (ROLE_PRIVILEGE_ESCALATION). SUPER_ADMIN administra a todos.',
    schema: errorEnvelopeSchema(),
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
  @ApiOperation({
    summary: 'Reactivar usuario',
    description:
      'Solo desde INACTIVE o SUSPENDED. Una cuenta ACTIVE o PENDING_ACTIVATION responde 406 INVALID_STATE.',
  })
  @ApiResponse({
    status: 200,
    schema: { $ref: getSchemaPath(ApiSuccessEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'El actor no puede administrar a ese usuario: su rol de mayor rango no está por debajo del rango del actor (ROLE_PRIVILEGE_ESCALATION). SUPER_ADMIN administra a todos.',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 406,
    description: 'La cuenta no está INACTIVE ni SUSPENDED (INVALID_STATE)',
    schema: errorEnvelopeSchema(),
  })
  reactivate(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<null> {
    return this.usersService.reactivate(id, user);
  }

  @Post(':id/mfa/reset')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('user:manage:global')
  @ApiOperation({
    summary: 'Restablecer el MFA de otro usuario (pérdida del dispositivo)',
    description:
      'Exige que quien lo hace tenga sesión con MFA y no sea el mismo usuario. Borra secreto, secreto pendiente y códigos de recuperación, revoca todas las sesiones del usuario afectado y lo obliga a enrolar MFA en su siguiente inicio de sesión (flujo mfaSetupToken de POST /auth/login), aunque su rol no lo exija. Queda en la bitácora quién, a quién, cuándo y el motivo (MFA_ADMIN_RESET), sin secretos.',
  })
  @ApiResponse({
    status: 200,
    schema: envelopedSchema(UserMfaResetResponseDto),
  })
  @ApiResponse({
    status: 400,
    description: 'Validación fallida: motivo ausente o corto (VALIDATION_FAILED)',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 403,
    description:
      'Sin permiso user:manage:global (INSUFFICIENT_PERMISSIONS), sesión sin MFA (MFA_SESSION_REQUIRED, action REAUTH), intento sobre sí mismo (MFA_SELF_RESET_FORBIDDEN) o usuario de rango igual o superior al del actor (ROLE_PRIVILEGE_ESCALATION)',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 404,
    description: 'Usuario inexistente (RESOURCE_NOT_FOUND)',
    schema: errorEnvelopeSchema(),
  })
  async resetMfa(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ResetUserMfaDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<UserMfaResetResponseDto> {
    const outcome = await this.usersService.resetMfa(id, dto.reason, user, {
      ipAddress,
      userAgent: userAgent ?? null,
    });
    return { ...outcome, mfaEnrollmentRequired: true };
  }

  @Post(':id/roles')
  @RequirePermission('role:assign:global')
  @ApiOperation({ summary: 'Asignar rol con scope y vigencia' })
  @ApiResponse({ status: 201, schema: envelopedSchema(UserRoleResponseDto) })
  assignRole(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: AssignUserRoleDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<UserRoleResponseDto> {
    return this.usersService.assignRole(id, dto, user, requestOrigin(ipAddress, userAgent));
  }

  @Delete(':id/roles/:userRoleId')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('role:assign:global')
  @ApiOperation({
    summary: 'Revocar asignación de rol',
    description:
      'Revoca también, en la misma transacción, las delegaciones hechas desde esa asignación (y las que se delegaron desde ellas). El cuerpo lleva el motivo obligatorio ({ reason }, 3..500), que queda en user_role.revocation_reason y en la bitácora.',
  })
  @ApiResponse({
    status: 200,
    schema: { $ref: getSchemaPath(ApiSuccessEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'El actor no puede administrar a ese usuario: su rol de mayor rango no está por debajo del rango del actor (ROLE_PRIVILEGE_ESCALATION). SUPER_ADMIN administra a todos.',
    schema: errorEnvelopeSchema(),
  })
  revokeRole(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('userRoleId', new ParseUUIDPipe({ version: '4' }))
    userRoleId: string,
    @Body() dto: RevokeUserRoleDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<null> {
    return this.usersService.revokeRole(id, userRoleId, dto, user, requestOrigin(ipAddress, userAgent));
  }

  @Post(':id/roles/:userRoleId/delegate')
  @RequirePermission('role:assign:global')
  @ApiOperation({
    summary: 'Delegar un rol activo a otro usuario',
    description:
      'Aplica las mismas reglas que asignar: el rol debe ser asignable (ROLE_NOT_ASSIGNABLE), administrable por el actor (ROLE_PRIVILEGE_ESCALATION) y con cupo (ROLE_MAX_USERS_REACHED; el titular ocupa un cupo). validUntil no puede superar el vencimiento de la asignación de origen (400 DELEGATION_EXCEEDS_SOURCE_VALIDITY). Revocar el origen revoca la delegación.',
  })
  @ApiResponse({ status: 201, schema: envelopedSchema(UserRoleResponseDto) })
  @ApiResponse({
    status: 400,
    description:
      'Sin vencimiento o vencido (DELEGATION_REQUIRES_EXPIRY) o posterior al vencimiento del origen (DELEGATION_EXCEEDS_SOURCE_VALIDITY)',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 403,
    description:
      'Autodelegación (ROLE_SELF_ASSIGNMENT_FORBIDDEN) o rol de rango igual o superior al del actor (ROLE_PRIVILEGE_ESCALATION)',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 406,
    description:
      'Rol no asignable (ROLE_NOT_ASSIGNABLE), sin cupo (ROLE_MAX_USERS_REACHED), destinatario = titular (INVALID_STATE) o asignación de origen no vigente (CANNOT_DELEGATE_ROLE_NOT_HELD)',
    schema: errorEnvelopeSchema(),
  })
  delegateRole(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('userRoleId', new ParseUUIDPipe({ version: '4' }))
    userRoleId: string,
    @Body() dto: DelegateUserRoleDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<UserRoleResponseDto> {
    return this.usersService.delegateRole(id, userRoleId, dto, user, requestOrigin(ipAddress, userAgent));
  }
}
