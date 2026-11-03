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
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiExtraModels,
  ApiOperation,
  ApiProduces,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Feature } from '../../common/decorators/feature.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import { ApiSuccessEnvelope, envelopedSchema, errorEnvelopeSchema } from '../../common/swagger/api-envelopes.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';
import { BoundedFileInterceptor, UPLOAD_LIMITS } from '../../shared/storage/uploads/bounded-file.interceptor.js';
import type { ReadableCostCenterScope } from '../roles/services/cost-center-scope.js';
import { AssetReadScope, AssetReadScopeGuard } from './asset-read-scope.guard.js';
import { LinkAssetPhotoDto, QueryAssetPhotoGalleryDto, UploadAssetPhotoDto } from './dto/asset-photo.dto.js';
import {
  AssetPhotoGalleryResponseDto,
  AssetPhotoLinkResponseDto,
  AssetPhotoResponseDto,
  AssetPhotoUnlinkResponseDto,
  StagedAssetPhotoResponseDto,
} from './dto/responses/asset-photo.response.dto.js';
import { AssetPhotosService, type PhotoContent, type PhotoUpload } from './services/asset-photos.service.js';

const READ_SCOPE =
  'Requiere asset:read:global o asset:read:org_unit. Un activo fuera del alcance responde 404 RESOURCE_NOT_FOUND, igual que uno que no existe.';

const UPLOAD_BODY = {
  schema: {
    type: 'object',
    required: ['file'],
    properties: {
      file: { type: 'string', format: 'binary', description: 'JPG, PNG o WebP de hasta 10 MB' },
      caption: { type: 'string', maxLength: 200 },
      primary: { type: 'boolean' },
    },
  },
};

const UPLOAD_ERRORS =
  'El tipo se comprueba por los bytes del archivo, no por su nombre: otro formato responde 400 FILE_TYPE_NOT_ALLOWED. Más de 10 MB responde 400 FILE_TOO_LARGE. Una imagen dañada o de más de 100 megapíxeles responde 400 ASSET_PHOTO_INVALID_IMAGE. Se guarda re-codificada, con 2560 px como máximo y sin EXIF ni GPS, más una miniatura WebP de 320 px.';

const IMAGE_RESPONSE = {
  status: 200,
  description:
    'Bytes de la imagen. Cache-Control: private, ETag con el sha256 del archivo (If-None-Match responde 304) y X-Content-Type-Options: nosniff.',
  content: {
    'image/jpeg': { schema: { type: 'string', format: 'binary' } },
    'image/png': { schema: { type: 'string', format: 'binary' } },
    'image/webp': { schema: { type: 'string', format: 'binary' } },
  },
};

const NOT_FOUND = { status: 404, description: 'RESOURCE_NOT_FOUND', schema: errorEnvelopeSchema() };

const etagMatches = (header: string | undefined, etag: string): boolean =>
  header !== undefined &&
  header
    .split(',')
    .map((value) => value.trim().replace(/^W\//, ''))
    .some((value) => value === etag || value === '*');

export const sendPhoto = async (request: Request, response: Response, content: PhotoContent): Promise<void> => {
  response.setHeader('Cache-Control', 'private, max-age=300');
  response.setHeader('ETag', content.etag);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (etagMatches(request.headers['if-none-match'], content.etag)) {
    response.status(HttpStatus.NOT_MODIFIED).end();
    return;
  }
  const body = await content.read();
  response.setHeader('Content-Type', content.contentType);
  response.setHeader('Content-Disposition', `inline; filename="${content.fileName}"`);
  response.send(body);
};

@ApiTags(OpenApiTag.Assets)
@ApiBearerAuth()
@ApiExtraModels(AssetPhotoResponseDto, AssetPhotoLinkResponseDto, AssetPhotoUnlinkResponseDto)
@Feature('assets')
@Controller('assets')
export class AssetPhotosController {
  constructor(private readonly photos: AssetPhotosService) {}

  @Post(':id/photos')
  @RequirePermission('asset:update:global')
  @UseInterceptors(BoundedFileInterceptor('file', UPLOAD_LIMITS.ASSET_PHOTO))
  @ApiConsumes('multipart/form-data')
  @ApiBody(UPLOAD_BODY)
  @ApiOperation({
    summary: 'Subir una foto del activo',
    description: `Se guarda en assets/<año>/<código del centro de costo>/<código del activo>_<fecha>_<n>.<ext> según el centro de costo actual del activo. ${UPLOAD_ERRORS}`,
  })
  @ApiResponse({ status: 201, schema: envelopedSchema(AssetPhotoResponseDto) })
  @ApiResponse(NOT_FOUND)
  upload(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @UploadedFile() file: PhotoUpload | undefined,
    @Body() dto: UploadAssetPhotoDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AssetPhotoResponseDto> {
    return this.photos.upload(id, file, { caption: dto.caption, primary: dto.primary }, user);
  }

  @Get(':id/photos')
  @UseGuards(AssetReadScopeGuard)
  @ApiOperation({ summary: 'Fotos del activo', description: `La principal primero. ${READ_SCOPE}` })
  @ApiResponse({ status: 200, schema: {
      allOf: [
        { $ref: getSchemaPath(ApiSuccessEnvelope) },
        { properties: { data: { type: 'array', items: { $ref: getSchemaPath(AssetPhotoResponseDto) } } } },
      ],
    }, })
  @ApiResponse(NOT_FOUND)
  list(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @AssetReadScope() scope: ReadableCostCenterScope,
  ): Promise<ReadonlyArray<AssetPhotoResponseDto>> {
    return this.photos.list(id, scope);
  }

  @Post(':id/photos/link')
  @RequirePermission('asset:update:global')
  @ApiOperation({
    summary: 'Poner en el activo una foto de la galería',
    description:
      'Si la foto ya está en otros activos se pone igual y la respuesta trae sus códigos en alsoLinkedTo y un aviso en warning. Si ya está en este activo responde 409 ASSET_PHOTO_ALREADY_LINKED.',
  })
  @ApiResponse({ status: 201, schema: envelopedSchema(AssetPhotoLinkResponseDto) })
  @ApiResponse(NOT_FOUND)
  link(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: LinkAssetPhotoDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AssetPhotoLinkResponseDto> {
    return this.photos.link(id, dto.photoFileId, dto.primary, user);
  }

  @Patch(':id/photos/:photoId/primary')
  @RequirePermission('asset:update:global')
  @ApiOperation({ summary: 'Elegir la foto principal', description: 'Solo hay una principal por activo.' })
  @ApiResponse({ status: 200, schema: envelopedSchema(AssetPhotoResponseDto) })
  @ApiResponse(NOT_FOUND)
  setPrimary(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('photoId', new ParseUUIDPipe({ version: '4' })) photoId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AssetPhotoResponseDto> {
    return this.photos.setPrimary(id, photoId, user);
  }

  @Delete(':id/photos/:photoId')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('asset:update:global')
  @ApiOperation({
    summary: 'Quitar una foto del activo',
    description: 'Solo la desvincula. El archivo sigue en el almacenamiento y en la galería.',
  })
  @ApiResponse({ status: 200, schema: envelopedSchema(AssetPhotoUnlinkResponseDto) })
  @ApiResponse(NOT_FOUND)
  unlink(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('photoId', new ParseUUIDPipe({ version: '4' })) photoId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AssetPhotoUnlinkResponseDto> {
    return this.photos.unlink(id, photoId, user);
  }

  @Get(':id/photos/:photoId/content')
  @UseGuards(AssetReadScopeGuard)
  @ApiProduces('image/jpeg', 'image/png', 'image/webp')
  @ApiOperation({ summary: 'Ver la foto', description: `Cada vista queda en la bitácora. ${READ_SCOPE}` })
  @ApiResponse(IMAGE_RESPONSE)
  @ApiResponse(NOT_FOUND)
  async content(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('photoId', new ParseUUIDPipe({ version: '4' })) photoId: string,
    @AssetReadScope() scope: ReadableCostCenterScope,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    await sendPhoto(request, response, await this.photos.content(id, photoId, 'content', scope, user));
  }

  @Get(':id/photos/:photoId/thumbnail')
  @UseGuards(AssetReadScopeGuard)
  @ApiProduces('image/webp')
  @ApiOperation({ summary: 'Ver la miniatura', description: `WebP de 320 px. Las vistas de miniaturas no quedan en la bitácora. ${READ_SCOPE}` })
  @ApiResponse(IMAGE_RESPONSE)
  @ApiResponse(NOT_FOUND)
  async thumbnail(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('photoId', new ParseUUIDPipe({ version: '4' })) photoId: string,
    @AssetReadScope() scope: ReadableCostCenterScope,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    await sendPhoto(request, response, await this.photos.content(id, photoId, 'thumbnail', scope, user));
  }
}

@ApiTags(OpenApiTag.Assets)
@ApiBearerAuth()
@ApiExtraModels(AssetPhotoGalleryResponseDto, StagedAssetPhotoResponseDto)
@Feature('assets')
@Controller('asset-photos')
export class AssetPhotoGalleryController {
  constructor(private readonly photos: AssetPhotosService) {}

  @Get()
  @UseGuards(AssetReadScopeGuard)
  @ApiOperation({
    summary: 'Galería de fotos subidas',
    description: `Fotos subidas desde la aplicación, por año de subida (por defecto el actual) y centro de costo. Solo muestra centros de costo del alcance del usuario. ${READ_SCOPE}`,
  })
  @ApiResponse({ status: 200, schema: envelopedSchema(AssetPhotoGalleryResponseDto) })
  gallery(
    @Query() query: QueryAssetPhotoGalleryDto,
    @AssetReadScope() scope: ReadableCostCenterScope,
  ): Promise<AssetPhotoGalleryResponseDto> {
    return this.photos.gallery(query, scope);
  }

  @Post('staged')
  @RequirePermission('asset:update:global')
  @UseInterceptors(BoundedFileInterceptor('file', UPLOAD_LIMITS.ASSET_PHOTO))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary', description: 'JPG, PNG o WebP de hasta 10 MB' } },
    },
  })
  @ApiOperation({
    summary: 'Subir una foto antes de crear el activo',
    description: `Queda pendiente en assets/_pendientes/ y devuelve un token que vence a las 24 horas. Las pendientes vencidas se borran cada día. ${UPLOAD_ERRORS}`,
  })
  @ApiResponse({ status: 201, schema: envelopedSchema(StagedAssetPhotoResponseDto) })
  stage(
    @UploadedFile() file: PhotoUpload | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<StagedAssetPhotoResponseDto> {
    return this.photos.stage(file, user);
  }

  @Get(':fileId/thumbnail')
  @UseGuards(AssetReadScopeGuard)
  @ApiProduces('image/webp')
  @ApiOperation({
    summary: 'Miniatura de una foto de la galería',
    description: `Visible si el centro de costo de la foto o algún activo que la tiene está en el alcance. ${READ_SCOPE}`,
  })
  @ApiResponse(IMAGE_RESPONSE)
  @ApiResponse(NOT_FOUND)
  async thumbnail(
    @Param('fileId', new ParseUUIDPipe({ version: '4' })) fileId: string,
    @AssetReadScope() scope: ReadableCostCenterScope,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    await sendPhoto(request, response, await this.photos.galleryThumbnail(fileId, scope));
  }
}
