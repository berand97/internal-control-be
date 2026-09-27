import { Controller, Get, HttpStatus, Param, Req, Res } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { ErrorCode } from '../../common/constants/error-code.enum.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { ApiException } from '../../common/exceptions/api.exception.js';
import { ApiErrorEnvelope, errorEnvelopeSchema } from '../../common/swagger/api-envelopes.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import { EMAIL_ASSET_PUBLIC_PATH, EmailAssetsService } from './email-assets.service.js';

/**
 * Límite propio, alto: el límite global (100/min por IP, app.module.ts) lo agotaría un solo proxy de imágenes (Gmail
 * descarga las imágenes de todos sus usuarios desde pocas IP de Google) apenas un aviso llegue a unas decenas de
 * personas. 1200/min por IP (20/s) sigue frenando una descarga masiva desde una sola IP. Las respuestas son
 * inmutables y cacheables un año, y un 304 no lee los bytes de la BD.
 */
export const PUBLIC_EMAIL_ASSET_THROTTLE = { default: { limit: 1200, ttl: 60_000 } } as const;

/** Cabeceras de una imagen pública (200 y 304). */
export const emailAssetHeaders = (etag: string): Record<string, string> => ({
  'Cache-Control': 'public, max-age=31536000, immutable',
  ETag: etag,
  'X-Content-Type-Options': 'nosniff',
  'Content-Disposition': 'inline',
  'Content-Security-Policy': "default-src 'none'",
  // Sin esto (o con same-origin, el valor de helmet) Outlook web y otros webmail no cargarían la imagen.
  'Cross-Origin-Resource-Policy': 'cross-origin',
});

const matchesEtag = (header: string | undefined, etag: string): boolean =>
  (header ?? '')
    .split(',')
    .map((item) => item.trim().replace(/^W\//, ''))
    .some((item) => item === etag || item === '*');

/**
 * GET /api/v1/public/email-assets/:id — imagen de una plantilla de correo, SIN sesión: la piden los clientes de correo
 * (y sus proxies) al abrir el mensaje. Fuera del módulo Correo a propósito (ni @Feature ni prefijo /mail): un correo
 * ya enviado sigue mostrando sus imágenes aunque el módulo se apague. Id inválido o inexistente: 404 genérico.
 */
@ApiTags(OpenApiTag.Mail)
@ApiExtraModels(ApiErrorEnvelope)
@Controller(EMAIL_ASSET_PUBLIC_PATH)
export class EmailAssetsPublicController {
  constructor(private readonly assets: EmailAssetsService) {}

  @Get(':id')
  @Public()
  @Throttle(PUBLIC_EMAIL_ASSET_THROTTLE)
  @ApiProduces('image/png', 'image/jpeg')
  @ApiOperation({
    summary: 'Imagen de una plantilla de correo (pública, sin sesión)',
    description:
      'Bytes de la imagen con su Content-Type. Cache-Control: public, max-age=31536000, immutable; ETag = "sha256" (If-None-Match → 304); X-Content-Type-Options: nosniff; Content-Disposition: inline; Content-Security-Policy: default-src \'none\'; Cross-Origin-Resource-Policy: cross-origin. Límite propio de 1200 solicitudes por minuto por IP.',
  })
  @ApiOkResponse({
    description: 'La imagen',
    content: {
      'image/png': { schema: { type: 'string', format: 'binary' } },
      'image/jpeg': { schema: { type: 'string', format: 'binary' } },
    },
  })
  @ApiResponse({ status: HttpStatus.NOT_MODIFIED, description: 'If-None-Match coincide con el ETag' })
  @ApiNotFoundResponse({ description: 'RESOURCE_NOT_FOUND: id inválido o inexistente', schema: errorEnvelopeSchema() })
  async serve(@Param('id') id: string, @Req() request: Request, @Res() response: Response): Promise<void> {
    const file = await this.assets.publicFile(id);
    if (!file) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    const etag = `"${file.sha256}"`;
    if (matchesEtag(request.headers['if-none-match'], etag)) {
      response.status(HttpStatus.NOT_MODIFIED).set(emailAssetHeaders(etag)).end();
      return;
    }
    const content = await this.assets.publicContent(id);
    if (!content) {
      throw new ApiException(ErrorCode.ResourceNotFound);
    }
    response
      .status(HttpStatus.OK)
      .set({ ...emailAssetHeaders(etag), 'Content-Type': file.mime, 'Content-Length': String(content.length) })
      .end(content);
  }
}
