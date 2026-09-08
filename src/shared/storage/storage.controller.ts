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
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Feature } from '../../common/decorators/feature.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import {
  ApiErrorEnvelope,
  ApiSuccessEnvelope,
} from '../../common/swagger/api-envelopes.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration.js';
import { UpdateStorageSettingsDto, flattenStoragePatch } from './dto/update-storage-settings.dto.js';
import { StorageService } from './storage.service.js';

@ApiTags(OpenApiTag.Storage)
@ApiBearerAuth()
@ApiExtraModels(ApiSuccessEnvelope, ApiErrorEnvelope)
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
  status(@CurrentUser() actor: AuthenticatedUser) {
    return this.storageService.status(actor.id);
  }

  @Get('status')
  @RequirePermission('storage:manage:global')
  @ApiOperation({ summary: 'Estado del almacenamiento activo' })
  statusAlias(@CurrentUser() actor: AuthenticatedUser) {
    return this.storageService.status(actor.id);
  }

  @Patch()
  @RequirePermission('storage:manage:global')
  @ApiOperation({ summary: 'Administrar proveedor de almacenamiento' })
  async updateRoot(
    @Body() dto: UpdateStorageSettingsDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    await this.storageService.updateSettings(flattenStoragePatch(dto), actor.id);
    return this.storageService.status(actor.id);
  }

  @Patch('settings')
  @RequirePermission('storage:manage:global')
  @ApiOperation({ summary: 'Administrar proveedor de almacenamiento' })
  async updateSettings(
    @Body() dto: UpdateStorageSettingsDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    await this.storageService.updateSettings(flattenStoragePatch(dto), actor.id);
    return this.storageService.status(actor.id);
  }

  @Post('test')
  @RequirePermission('storage:manage:global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Probar conexión del proveedor activo' })
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
  async googleStart(@CurrentUser() actor: AuthenticatedUser) {
    return this.startGoogle(undefined, actor);
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
  ) {
    return this.startGoogle(dto, actor);
  }

  @Get('oauth/onedrive/start')
  @RequirePermission('storage:manage:global')
  @ApiOperation({ summary: 'URL de conexión con Microsoft OneDrive' })
  async onedriveStart(@CurrentUser() actor: AuthenticatedUser) {
    const authorizationUrl = await this.storageService.oauthStartUrl(
      'onedrive',
      actor.id,
    );
    return { authorizationUrl };
  }

  @Get('oauth/google/callback')
  @Public()
  async googleCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() response: Response,
  ): Promise<void> {
    await this.storageService.oauthCallback('google_drive', code, state);
    const app = this.config.getOrThrow('appPublicUrl', { infer: true });
    response.redirect(`${app}/storage?connected=google_drive`);
  }

  @Get('oauth/onedrive/callback')
  @Public()
  async onedriveCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() response: Response,
  ): Promise<void> {
    await this.storageService.oauthCallback('onedrive', code, state);
    const app = this.config.getOrThrow('appPublicUrl', { infer: true });
    response.redirect(`${app}/storage?connected=onedrive`);
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
  ) {
    const patch = flattenStoragePatch(dto ?? {});
    if (Object.keys(patch).length > 0) {
      await this.storageService.updateSettings(patch, actor.id);
    }
    const authorizationUrl = await this.storageService.oauthStartUrl(
      'google_drive',
      actor.id,
    );
    return { authorizationUrl };
  }
}
