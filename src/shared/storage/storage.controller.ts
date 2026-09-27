import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { CookieOptions, Request, Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Feature } from '../../common/decorators/feature.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import {
  ApiErrorEnvelope,
  envelopedSchema,
  ApiSuccessEnvelope,
} from '../../common/swagger/api-envelopes.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration.js';
import {
  StorageBucketStateDto,
  StorageCheckDto,
  StorageTestResultDto,
} from './dto/storage-test.responses.js';
import { UpdateStorageSettingsDto, flattenStoragePatch } from './dto/update-storage-settings.dto.js';
import { OAUTH_STATE_TTL_SECONDS, StorageService, type OauthProvider } from './storage.service.js';

/** Cookie que liga el `state` OAuth al navegador que inició la conexión (BE-15). */
export const STORAGE_OAUTH_COOKIE = 'storage_oauth_binding';

@ApiTags(OpenApiTag.Storage)
@ApiBearerAuth()
@ApiExtraModels(ApiSuccessEnvelope, ApiErrorEnvelope, StorageTestResultDto, StorageCheckDto, StorageBucketStateDto)
@Feature('storage')
@Controller('storage')
export class StorageController {
  constructor(
    private readonly storageService: StorageService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  @Get()
  @RequirePermission('storage:manage:global')
  @ApiOperation({ summary: 'Estado del almacenamiento activo' })
  status() {
    return this.storageService.status();
  }

  @Get('status')
  @RequirePermission('storage:manage:global')
  @ApiOperation({ summary: 'Estado del almacenamiento activo' })
  statusAlias() {
    return this.storageService.status();
  }

  @Patch()
  @RequirePermission('storage:manage:global')
  @ApiOperation({ summary: 'Administrar proveedor de almacenamiento' })
  async updateRoot(
    @Body() dto: UpdateStorageSettingsDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    await this.storageService.updateSettings(flattenStoragePatch(dto), actor.id);
    return this.storageService.status();
  }

  @Patch('settings')
  @RequirePermission('storage:manage:global')
  @ApiOperation({ summary: 'Administrar proveedor de almacenamiento' })
  async updateSettings(
    @Body() dto: UpdateStorageSettingsDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    await this.storageService.updateSettings(flattenStoragePatch(dto), actor.id);
    return this.storageService.status();
  }

  @Post('test')
  @RequirePermission('storage:manage:global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Probar conexión del proveedor activo',
    description:
      'Con S3 (MinIO, AWS…) responde siempre 200 con el detalle de cada comprobación: destino permitido (BE-16), endpoint alcanzable, credenciales, bucket, escritura/lectura/borrado de health/probe-<uuid>.txt, versionado y object lock. ok=false si alguna terminó en FAILED. Con project/Google Drive/OneDrive los errores siguen llegando como error HTTP (p. ej. 424 STORAGE_OAUTH_REQUIRED).',
  })
  @ApiOkResponse({ schema: envelopedSchema(StorageTestResultDto) })
  test() {
    return this.storageService.testConnection();
  }

  @Get('oauth/google/start')
  @RequirePermission('storage:manage:global')
  @ApiOperation({
    summary: 'URL de conexión con Google Drive',
    description:
      'Requiere Client ID ya guardado. Para guardar y conectar en un paso usa POST /storage/oauth/google/start',
  })
  async googleStart(
    @CurrentUser() actor: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.startGoogle(undefined, actor, response);
  }

  @Post('oauth/google/start')
  @RequirePermission('storage:manage:global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Guardar credenciales de Google (opcional) y devolver URL OAuth',
  })
  async googleStartPost(
    @Body() dto: UpdateStorageSettingsDto = {},
    @CurrentUser() actor: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.startGoogle(dto, actor, response);
  }

  @Get('oauth/onedrive/start')
  @RequirePermission('storage:manage:global')
  @ApiOperation({ summary: 'URL de conexión con Microsoft OneDrive' })
  async onedriveStart(
    @CurrentUser() actor: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.start('onedrive', actor, response);
  }

  @Get('oauth/google/callback')
  @Public()
  @ApiOperation({
    summary: 'Retorno de Google (OAuth)',
    description:
      'state de un solo uso, 10 minutos, ligado a la cookie storage_oauth_binding del navegador que llamó a start. Si no cuadra: 424 STORAGE_OAUTH_FAILED',
  })
  async googleCallback(
    @Query('code') code: unknown,
    @Query('state') state: unknown,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    await this.callback('google_drive', code, state, request, response);
  }

  @Get('oauth/onedrive/callback')
  @Public()
  @ApiOperation({
    summary: 'Retorno de Microsoft (OAuth)',
    description:
      'state de un solo uso, 10 minutos, ligado a la cookie storage_oauth_binding del navegador que llamó a start. Si no cuadra: 424 STORAGE_OAUTH_FAILED',
  })
  async onedriveCallback(
    @Query('code') code: unknown,
    @Query('state') state: unknown,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    await this.callback('onedrive', code, state, request, response);
  }

  @Get('objects')
  @RequirePermission('storage:manage:global')
  @Header('Cache-Control', 'private, max-age=60')
  @ApiOperation({ summary: 'Descargar un objeto del almacenamiento activo' })
  async download(
    @Query('key') key: string,
    @Res() response: Response,
  ): Promise<void> {
    const body = await this.storageService.get(key);
    response.setHeader('Content-Type', 'application/octet-stream');
    response.send(body);
  }

  private async startGoogle(
    dto: UpdateStorageSettingsDto | undefined,
    actor: AuthenticatedUser,
    response: Response,
  ) {
    const patch = flattenStoragePatch(dto ?? {});
    if (Object.keys(patch).length > 0) {
      await this.storageService.updateSettings(patch, actor.id);
    }
    return this.start('google_drive', actor, response);
  }

  private async start(provider: OauthProvider, actor: AuthenticatedUser, response: Response) {
    const { authorizationUrl, browserBinding } = await this.storageService.startOauth(provider, actor.id);
    response.cookie(STORAGE_OAUTH_COOKIE, browserBinding, {
      ...this.oauthCookieOptions(),
      maxAge: OAUTH_STATE_TTL_SECONDS * 1000,
    });
    return { authorizationUrl };
  }

  private async callback(
    provider: OauthProvider,
    code: unknown,
    state: unknown,
    request: Request,
    response: Response,
  ): Promise<void> {
    const cookies = request.cookies as Record<string, unknown> | undefined;
    const binding = cookies?.[STORAGE_OAUTH_COOKIE];
    // Un intento, acierte o no: la cookie ya no sirve.
    response.clearCookie(STORAGE_OAUTH_COOKIE, this.oauthCookieOptions());
    await this.storageService.oauthCallback(provider, code, state, binding);
    const app = this.config.getOrThrow('appPublicUrl', { infer: true });
    response.redirect(`${app}/storage?connected=${provider}`);
  }

  /**
   * HttpOnly y SameSite=Lax: el regreso desde Google o Microsoft es una navegación de primer nivel y debe llevarla.
   * Ruta: la parte de API_PUBLIC_URL más /api/v1/storage/oauth, para que solo viaje a start y a los callbacks.
   */
  private oauthCookieOptions(): CookieOptions {
    const base = new URL(this.config.getOrThrow('apiPublicUrl', { infer: true })).pathname.replace(/\/+$/, '');
    return {
      httpOnly: true,
      secure: this.config.getOrThrow('refreshCookie', { infer: true }).secure,
      sameSite: 'lax',
      path: `${base}/api/v1/storage/oauth`,
    };
  }
}
