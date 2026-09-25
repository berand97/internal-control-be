import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { AllowWhileMustChangePassword } from '../../common/decorators/allow-while-must-change-password.decorator.js';
import { Feature } from '../../common/decorators/feature.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { RefreshTokenCookie } from '../../common/decorators/refresh-token-cookie.decorator.js';
import {
  ApiErrorEnvelope,
  ApiSuccessEnvelope,
  envelopedOneOfSchema,
  envelopedSchema,
  errorEnvelopeSchema,
} from '../../common/swagger/api-envelopes.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';
import { ChangePasswordDto } from './dto/change-password.dto.js';
import { ForgotPasswordDto } from './dto/forgot-password.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { ResetPasswordDto } from './dto/reset-password.dto.js';
import { MfaProofDto } from './dto/mfa-proof.dto.js';
import { VerifyMfaDto } from './dto/verify-mfa.dto.js';
import { VerifyRecoveryCodeDto } from './dto/verify-recovery-code.dto.js';
import { FeatureResponseDto } from '../features/dto/feature.response.dto.js';
import { LoginResponseDto } from './dto/responses/login-response.dto.js';
import { MeResponseDto } from './dto/responses/me-response.dto.js';
import { NavigationItemResponseDto } from './dto/responses/navigation-item.response.dto.js';
import { ResourceCapabilityResponseDto } from './dto/responses/resource-capability.response.dto.js';
import { MfaChallengeResponseDto } from './dto/responses/mfa-challenge-response.dto.js';
import { MfaEnrollmentResponseDto } from './dto/responses/mfa-enrollment.response.dto.js';
import { MfaDisabledResponseDto } from './dto/responses/mfa-disabled.response.dto.js';
import { MfaPendingEnrollmentResponseDto } from './dto/responses/mfa-pending-enrollment.response.dto.js';
import { MfaRecoveryCodesResponseDto } from './dto/responses/mfa-recovery-codes.response.dto.js';
import { MfaSetupConfirmedResponseDto } from './dto/responses/mfa-setup-confirmed.response.dto.js';
import { MfaSetupRequiredResponseDto } from './dto/responses/mfa-setup-required.response.dto.js';
import { RecoveryLoginResponseDto } from './dto/responses/recovery-login-response.dto.js';
import { RefreshResponseDto } from './dto/responses/refresh-response.dto.js';
import { AuthService } from './services/auth.service.js';
import { MfaAccountService } from './services/mfa-account.service.js';
import { RefreshCookieService } from './services/refresh-cookie.service.js';

const AUTH_THROTTLE = { default: { limit: 5, ttl: 900_000 } } as const;
const MFA_THROTTLE = { default: { limit: 3, ttl: 300_000 } } as const;
const FORGOT_PASSWORD_THROTTLE = { default: { limit: 3, ttl: 3_600_000 } } as const;

@ApiTags(OpenApiTag.Auth)
@ApiExtraModels(
  ApiSuccessEnvelope,
  ApiErrorEnvelope,
  LoginResponseDto,
  MfaChallengeResponseDto,
  MfaSetupRequiredResponseDto,
  MfaEnrollmentResponseDto,
  MfaDisabledResponseDto,
  MfaPendingEnrollmentResponseDto,
  MfaRecoveryCodesResponseDto,
  MfaSetupConfirmedResponseDto,
  RecoveryLoginResponseDto,
  RefreshResponseDto,
  MeResponseDto,
  NavigationItemResponseDto,
  ResourceCapabilityResponseDto,
  FeatureResponseDto,
)
@Feature('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly refreshCookieService: RefreshCookieService,
    private readonly mfaAccount: MfaAccountService,
  ) {}

  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle(AUTH_THROTTLE)
  @ApiOperation({
    summary: 'Iniciar sesión',
    description:
      'Valida credenciales contra app_user (Argon2id). Sin MFA retorna el access token en el body y el refresh token en cookie HttpOnly. Si la cuenta fue invitada, user.mustChangePassword=true y el cliente debe forzar el cambio de contraseña. Con MFA activo retorna un token de desafío válido sólo para POST /auth/mfa/verify.',
  })
  @ApiResponse({
    status: 200,
    description: 'Sesión iniciada o desafío MFA requerido',
    schema: envelopedOneOfSchema(
      LoginResponseDto,
      MfaChallengeResponseDto,
      MfaSetupRequiredResponseDto,
    ),
  })
  @ApiResponse({
    status: 400,
    description: 'Validación fallida (VALIDATION_FAILED)',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 401,
    description: 'Credenciales inválidas (INVALID_CREDENTIALS)',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 403,
    description: 'Cuenta suspendida o inactiva (USER_SUSPENDED, USER_INACTIVE)',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 429,
    description: 'Demasiados intentos (TOO_MANY_ATTEMPTS)',
    schema: errorEnvelopeSchema(),
  })
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<
    | LoginResponseDto
    | MfaChallengeResponseDto
    | MfaSetupRequiredResponseDto
  > {
    const outcome = await this.authService.login(dto, {
      ipAddress,
      userAgent: userAgent ?? null,
    });
    this.refreshCookieService.attach(res, outcome.refreshToken);
    return outcome.response;
  }

  @Post('mfa/verify')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle(MFA_THROTTLE)
  @ApiOperation({
    summary: 'Verificar código MFA del desafío',
    description:
      'Segundo paso del login con MFA. Requiere el header Authorization: Bearer <mfaChallengeToken> emitido por POST /auth/login y un código TOTP de 6 dígitos.',
  })
  @ApiResponse({
    status: 200,
    description: 'Sesión iniciada tras validar el segundo factor',
    schema: envelopedSchema(LoginResponseDto),
  })
  @ApiResponse({
    status: 400,
    description: 'Validación fallida (VALIDATION_FAILED)',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 401,
    description:
      'Desafío ausente/inválido (MFA_REQUIRED) o código incorrecto (MFA_CODE_INVALID)',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 403,
    description: 'Cuenta suspendida o inactiva (USER_SUSPENDED, USER_INACTIVE)',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 429,
    description: 'Demasiados intentos (TOO_MANY_ATTEMPTS)',
    schema: errorEnvelopeSchema(),
  })
  async verifyMfa(
    @Body() dto: VerifyMfaDto,
    @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) res: Response,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<LoginResponseDto> {
    const outcome = await this.authService.verifyMfa(dto, authorization, {
      ipAddress,
      userAgent: userAgent ?? null,
    });
    this.refreshCookieService.attach(res, outcome.refreshToken);
    return outcome.response;
  }

  @Post('mfa/recovery')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle(MFA_THROTTLE)
  @ApiOperation({
    summary: 'Iniciar sesión con un código de recuperación',
    description:
      'Alternativa a POST /auth/mfa/verify cuando no se tiene el dispositivo. Requiere Authorization: Bearer <mfaChallengeToken> y un código de recuperación de un solo uso, que queda consumido. La sesión cuenta como sesión con MFA.',
  })
  @ApiResponse({
    status: 200,
    description: 'Sesión iniciada; informa cuántos códigos quedan',
    schema: envelopedSchema(RecoveryLoginResponseDto),
  })
  @ApiResponse({
    status: 400,
    description: 'Validación fallida (VALIDATION_FAILED)',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 401,
    description:
      'Desafío ausente/inválido (MFA_REQUIRED) o código inexistente o ya usado (MFA_CODE_INVALID)',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 403,
    description: 'Cuenta suspendida o inactiva (USER_SUSPENDED, USER_INACTIVE)',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 429,
    description: 'Demasiados intentos (TOO_MANY_ATTEMPTS)',
    schema: errorEnvelopeSchema(),
  })
  async verifyRecoveryCode(
    @Body() dto: VerifyRecoveryCodeDto,
    @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) res: Response,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<RecoveryLoginResponseDto> {
    const outcome = await this.authService.verifyRecoveryCode(
      dto,
      authorization,
      { ipAddress, userAgent: userAgent ?? null },
    );
    this.refreshCookieService.attach(res, outcome.refreshToken);
    return outcome.response;
  }

  @Post('mfa/setup')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle(MFA_THROTTLE)
  @ApiOperation({
    summary: 'Iniciar enrolamiento MFA obligatorio',
    description:
      'Requiere Authorization: Bearer <mfaSetupToken> emitido por POST /auth/login cuando el rol administrativo aún no tiene MFA. Devuelve el secreto, la URI otpauth y el QR PNG en data URL.',
  })
  @ApiResponse({
    status: 200,
    schema: envelopedSchema(MfaEnrollmentResponseDto),
  })
  @ApiResponse({ status: 401, schema: errorEnvelopeSchema() })
  beginMfaSetup(
    @Headers('authorization') authorization: string | undefined,
  ): Promise<MfaEnrollmentResponseDto> {
    return this.authService.beginMfaSetup(authorization);
  }

  @Post('mfa/confirm')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle(MFA_THROTTLE)
  @ApiOperation({
    summary: 'Confirmar enrolamiento MFA y emitir sesión',
    description:
      'Valida el código TOTP del secreto recién enrolado, activa MFA, genera 10 códigos de recuperación (se muestran solo en esta respuesta) e inicia sesión con MFA.',
  })
  @ApiResponse({
    status: 200,
    schema: envelopedSchema(MfaSetupConfirmedResponseDto),
  })
  @ApiResponse({
    status: 401,
    description:
      'Token de setup ausente/inválido (MFA_REQUIRED) o código incorrecto (MFA_CODE_INVALID)',
    schema: errorEnvelopeSchema(),
  })
  async confirmMfaSetup(
    @Body() dto: VerifyMfaDto,
    @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) res: Response,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<MfaSetupConfirmedResponseDto> {
    const outcome = await this.authService.confirmMfaSetup(
      dto,
      authorization,
      {
        ipAddress,
        userAgent: userAgent ?? null,
      },
    );
    this.refreshCookieService.attach(res, outcome.refreshToken);
    return outcome.response;
  }

  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Renovar la sesión',
    description:
      'Lee el refresh token de la cookie HttpOnly, rota la familia (nuevo jti) y emite un nuevo par access + refresh. Si el refresh presentado ya fue usado o la familia está revocada, invalida toda la familia, audita el intento de reuso y responde 401 TOKEN_EXPIRED.',
  })
  @ApiResponse({
    status: 200,
    description: 'Nuevo access token en body; nuevo refresh token en cookie',
    schema: envelopedSchema(RefreshResponseDto),
  })
  @ApiResponse({
    status: 401,
    description:
      'Refresh inválido, expirado, reusado o de familia revocada (TOKEN_EXPIRED). Limpia la cookie.',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 403,
    description: 'Cuenta suspendida o inactiva (USER_SUSPENDED, USER_INACTIVE)',
    schema: errorEnvelopeSchema(),
  })
  async refresh(
    @RefreshTokenCookie() refreshToken: string | undefined,
    @Res({ passthrough: true }) res: Response,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<RefreshResponseDto> {
    const outcome = await this.authService.refresh(refreshToken, {
      ipAddress,
      userAgent: userAgent ?? null,
    });
    this.refreshCookieService.attach(res, outcome.refreshToken);
    return outcome.response;
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @AllowWhileMustChangePassword()
  @ApiOperation({
    summary: 'Cerrar sesión',
    description:
      'Revoca todas las familias de refresh tokens activas del usuario y limpia la cookie. El access token sigue vigente hasta su expiración natural (JWT stateless).',
  })
  @ApiResponse({
    status: 200,
    description: 'Sesión cerrada; data es null',
    schema: { $ref: getSchemaPath(ApiSuccessEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Token ausente o inválido (UNAUTHORIZED, TOKEN_EXPIRED)',
    schema: errorEnvelopeSchema(),
  })
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<null> {
    await this.authService.logout(user, {
      ipAddress,
      userAgent: userAgent ?? null,
    });
    this.refreshCookieService.clear(res);
    return null;
  }

  @Get('me')
  @ApiBearerAuth()
  @AllowWhileMustChangePassword()
  @ApiOperation({
    summary: 'Perfil del usuario autenticado',
    description:
      'Usuario autenticado, roles (informativos), capabilities por recurso y navigation ya filtrada. La UI no debe ramificar por código de rol.',
  })
  @ApiResponse({
    status: 200,
    description: 'Datos del usuario autenticado',
    schema: envelopedSchema(MeResponseDto),
  })
  @ApiResponse({
    status: 401,
    description: 'Token ausente o inválido (UNAUTHORIZED, TOKEN_EXPIRED)',
    schema: errorEnvelopeSchema(),
  })
  async me(@CurrentUser() user: AuthenticatedUser): Promise<MeResponseDto> {
    return this.authService.me(user);
  }

  @Post('me/mfa/enrollment')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @Throttle(MFA_THROTTLE)
  @ApiOperation({
    summary: 'Iniciar enrolamiento o cambio de dispositivo MFA desde la sesión',
    description:
      'Genera un secreto TOTP pendiente (QR y URI otpauth) válido 15 minutos. Si la cuenta ya tiene MFA, exige code (TOTP del dispositivo actual) o recoveryCode (se consume). El secreto pendiente no reemplaza al vigente hasta POST /auth/me/mfa/enrollment/confirm; iniciar de nuevo descarta el pendiente anterior.',
  })
  @ApiResponse({
    status: 200,
    schema: envelopedSchema(MfaPendingEnrollmentResponseDto),
  })
  @ApiResponse({
    status: 400,
    description: 'Validación fallida (VALIDATION_FAILED)',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 401,
    description: 'Token ausente o inválido (UNAUTHORIZED, TOKEN_EXPIRED)',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 403,
    description:
      'Con MFA activo: falta la prueba del factor actual o no es válida (MFA_VERIFICATION_FAILED)',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 429,
    description: 'Demasiados intentos (TOO_MANY_ATTEMPTS)',
    schema: errorEnvelopeSchema(),
  })
  startMfaEnrollment(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: MfaProofDto,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<MfaPendingEnrollmentResponseDto> {
    return this.mfaAccount.startEnrollment(user, dto, {
      ipAddress,
      userAgent: userAgent ?? null,
    });
  }

  @Post('me/mfa/enrollment/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @Throttle(MFA_THROTTLE)
  @ApiOperation({
    summary: 'Confirmar el enrolamiento MFA desde la sesión',
    description:
      'Valida un TOTP del secreto pendiente, lo convierte en el factor vigente, reemplaza los códigos de recuperación por 10 nuevos (se muestran solo en esta respuesta) y marca la sesión actual como sesión con MFA. Si era un cambio de dispositivo, revoca las demás sesiones del usuario.',
  })
  @ApiResponse({
    status: 200,
    schema: envelopedSchema(MfaRecoveryCodesResponseDto),
  })
  @ApiResponse({
    status: 400,
    description: 'Validación fallida (VALIDATION_FAILED)',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 401,
    description: 'Token ausente o inválido (UNAUTHORIZED, TOKEN_EXPIRED)',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 403,
    description: 'Código incorrecto (MFA_VERIFICATION_FAILED)',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 409,
    description:
      'No hay enrolamiento en curso o expiró (MFA_ENROLLMENT_NOT_STARTED)',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 429,
    description: 'Demasiados intentos (TOO_MANY_ATTEMPTS)',
    schema: errorEnvelopeSchema(),
  })
  confirmMfaEnrollment(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: VerifyMfaDto,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<MfaRecoveryCodesResponseDto> {
    return this.mfaAccount.confirmEnrollment(user, dto, {
      ipAddress,
      userAgent: userAgent ?? null,
    });
  }

  @Post('me/mfa/recovery-codes')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @Throttle(MFA_THROTTLE)
  @ApiOperation({
    summary: 'Regenerar los códigos de recuperación',
    description:
      'Exige una sesión con MFA. Invalida todos los códigos anteriores (usados o no) y devuelve 10 nuevos, que se muestran solo en esta respuesta.',
  })
  @ApiResponse({
    status: 200,
    schema: envelopedSchema(MfaRecoveryCodesResponseDto),
  })
  @ApiResponse({
    status: 401,
    description: 'Token ausente o inválido (UNAUTHORIZED, TOKEN_EXPIRED)',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 403,
    description:
      'La sesión no se abrió con segundo factor (MFA_SESSION_REQUIRED, action REAUTH)',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 409,
    description: 'La cuenta no tiene MFA activo (MFA_NOT_ENABLED)',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 429,
    description: 'Demasiados intentos (TOO_MANY_ATTEMPTS)',
    schema: errorEnvelopeSchema(),
  })
  regenerateRecoveryCodes(
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<MfaRecoveryCodesResponseDto> {
    return this.mfaAccount.regenerateRecoveryCodes(user, {
      ipAddress,
      userAgent: userAgent ?? null,
    });
  }

  @Post('me/mfa/disable')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @Throttle(MFA_THROTTLE)
  @ApiOperation({
    summary: 'Desactivar MFA',
    description:
      'Solo si ningún rol activo del usuario exige MFA (SUPER_ADMIN, INTERNAL_CONTROL_DIRECTOR). Exige code o recoveryCode. Borra secreto y códigos y revoca las demás sesiones. Sin MFA la sesión deja de contar como sesión con MFA, así que el usuario no podrá firmar actas que lo exijan.',
  })
  @ApiResponse({
    status: 200,
    description: 'MFA desactivado',
    schema: envelopedSchema(MfaDisabledResponseDto),
  })
  @ApiResponse({
    status: 400,
    description: 'Validación fallida (VALIDATION_FAILED)',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 401,
    description: 'Token ausente o inválido (UNAUTHORIZED, TOKEN_EXPIRED)',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 403,
    description:
      'Rol que exige MFA (MFA_REQUIRED_BY_ROLE) o prueba del factor inválida (MFA_VERIFICATION_FAILED)',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 409,
    description: 'La cuenta no tiene MFA activo (MFA_NOT_ENABLED)',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 429,
    description: 'Demasiados intentos (TOO_MANY_ATTEMPTS)',
    schema: errorEnvelopeSchema(),
  })
  disableMfa(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: MfaProofDto,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<MfaDisabledResponseDto> {
    return this.mfaAccount.disable(user, dto, {
      ipAddress,
      userAgent: userAgent ?? null,
    });
  }

  @Post('forgot-password')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle(FORGOT_PASSWORD_THROTTLE)
  @ApiOperation({
    summary: 'Solicitar restablecimiento de contraseña',
    description:
      'Si el correo existe, genera un token de 30 minutos y envía el enlace. La respuesta es idéntica cuando el correo no existe para no filtrar cuentas.',
  })
  @ApiResponse({
    status: 200,
    description: 'Solicitud aceptada; data es null',
    schema: { $ref: getSchemaPath(ApiSuccessEnvelope) },
  })
  @ApiResponse({
    status: 400,
    description: 'Validación fallida (VALIDATION_FAILED)',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 429,
    description: 'Demasiados intentos (TOO_MANY_ATTEMPTS)',
    schema: errorEnvelopeSchema(),
  })
  async forgotPassword(
    @Body() dto: ForgotPasswordDto,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<null> {
    return this.authService.forgotPassword(dto, {
      ipAddress,
      userAgent: userAgent ?? null,
    });
  }

  @Post('reset-password')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Restablecer contraseña con token',
    description:
      'Valida el token de un solo uso, actualiza el hash, activa la cuenta si estaba pendiente e invalida todas las sesiones.',
  })
  @ApiResponse({
    status: 200,
    description: 'Contraseña actualizada; data es null',
    schema: { $ref: getSchemaPath(ApiSuccessEnvelope) },
  })
  @ApiResponse({
    status: 400,
    description: 'Validación fallida (VALIDATION_FAILED)',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 401,
    description: 'Token inválido o expirado (PASSWORD_RESET_INVALID)',
    schema: errorEnvelopeSchema(),
  })
  async resetPassword(
    @Body() dto: ResetPasswordDto,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<null> {
    return this.authService.resetPassword(dto, {
      ipAddress,
      userAgent: userAgent ?? null,
    });
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @AllowWhileMustChangePassword()
  @ApiOperation({
    summary: 'Cambiar contraseña del usuario autenticado',
    description:
      'Verifica la contraseña actual (o la temporal de la invitación), aplica la política, activa la cuenta si estaba pendiente e invalida todas las sesiones. El cliente debe volver a iniciar sesión.',
  })
  @ApiResponse({
    status: 200,
    description: 'Contraseña cambiada; data es null',
    schema: { $ref: getSchemaPath(ApiSuccessEnvelope) },
  })
  @ApiResponse({
    status: 400,
    description: 'Validación fallida (VALIDATION_FAILED)',
    schema: errorEnvelopeSchema(),
  })
  @ApiResponse({
    status: 401,
    description: 'Contraseña actual incorrecta (INVALID_CREDENTIALS)',
    schema: errorEnvelopeSchema(),
  })
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<null> {
    return this.authService.changePassword(user, dto, {
      ipAddress,
      userAgent: userAgent ?? null,
    });
  }
}
