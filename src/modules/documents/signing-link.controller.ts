import { Body, Controller, Get, Headers, HttpCode, Ip, Param, Post, Res } from '@nestjs/common';
import { ApiExtraModels, ApiOkResponse, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import type { Response } from 'express';
import { Feature } from '../../common/decorators/feature.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { ApiSuccessEnvelope, envelopedSchema } from '../../common/swagger/api-envelopes.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import {
  SigningLinkIdentityResponseDto,
  SigningLinkResultResponseDto,
  SigningLinkViewResponseDto,
} from './dto/document.responses.js';
import { DocumentEngineService } from './services/document-engine.service.js';

/** El token del enlace: 32 bytes en base64url. */
export class SigningLinkParams {
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  readonly token!: string;
}

export class ConfirmIdentityDto {
  @Matches(/^\d{4}$/, { message: 'last4 son los últimos 4 dígitos del número de documento' })
  readonly last4!: string;
}

export class SignByLinkDto {
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  readonly identityToken!: string;

  @IsString()
  @MaxLength(90_000)
  readonly rubric!: string;
}

export class RejectByLinkDto {
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  readonly identityToken!: string;

  @IsString()
  @MinLength(5)
  @MaxLength(500)
  readonly reason!: string;
}

const READ_THROTTLE = { default: { limit: 30, ttl: 60_000 } } as const;
const IDENTITY_THROTTLE = { default: { limit: 10, ttl: 900_000 } } as const;
const ACTION_THROTTLE = { default: { limit: 10, ttl: 60_000 } } as const;

/**
 * Firma sin sesión por enlace de un solo uso (página pública /firmar/:token del frontend). Solo expone el acta del
 * enlace, y solo mientras el enlace está vigente. El token y el número de documento nunca vuelven en una respuesta
 * ni se registran.
 */
@ApiTags(OpenApiTag.DocumentTemplates)
@ApiExtraModels(ApiSuccessEnvelope, SigningLinkViewResponseDto, SigningLinkIdentityResponseDto, SigningLinkResultResponseDto)
@Feature('document-templates')
@Controller('public/signing-links')
export class SigningLinkController {
  constructor(private readonly engine: DocumentEngineService) {}

  @Get(':token')
  @Public()
  @Throttle(READ_THROTTLE)
  @ApiOperation({
    summary: 'Estado del enlace de firma',
    description:
      'Sin sesión. Metadatos mínimos del acta (formato, número, rol del turno, nombre enmascarado) solo si status es ACTIVE. Token inexistente: 404 RESOURCE_NOT_FOUND.',
  })
  @ApiOkResponse({ schema: envelopedSchema(SigningLinkViewResponseDto) })
  view(@Param() params: SigningLinkParams) {
    return this.engine.signingLinkView(params.token);
  }

  @Get(':token/pdf')
  @Public()
  @Throttle(READ_THROTTLE)
  @ApiProduces('application/pdf')
  @ApiOperation({
    summary: 'PDF vigente del acta para leerla antes de firmar',
    description: 'Solo con enlace ACTIVE (si no, 410 SIGNATURE_LINK_UNAVAILABLE). Se sirve inline.',
  })
  async pdf(@Param() params: SigningLinkParams, @Res() response: Response) {
    const file = await this.engine.signingLinkPdf(params.token);
    response.setHeader('Content-Type', 'application/pdf');
    response.setHeader('Content-Disposition', `inline; filename="${file.fileName}"`);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.send(file.body);
  }

  @Post(':token/identity')
  @HttpCode(200)
  @Public()
  @Throttle(IDENTITY_THROTTLE)
  @ApiOperation({
    summary: 'Confirmar identidad con los últimos 4 dígitos del documento',
    description:
      'Devuelve identityToken (10 minutos) para firmar o rechazar. Errores: 403 SIGNATURE_IDENTITY_MISMATCH (details dice cuántos intentos quedan), 410 SIGNATURE_IDENTITY_LOCKED (quinto fallo: el enlace queda invalidado), 410 SIGNATURE_LINK_UNAVAILABLE, 409 SIGNATURE_NO_IDENTITY_CHECK.',
  })
  @ApiOkResponse({ schema: envelopedSchema(SigningLinkIdentityResponseDto) })
  identity(@Param() params: SigningLinkParams, @Body() dto: ConfirmIdentityDto) {
    return this.engine.confirmSigningLinkIdentity(params.token, dto.last4);
  }

  @Post(':token/sign')
  @HttpCode(200)
  @Public()
  @Throttle(ACTION_THROTTLE)
  @ApiOperation({
    summary: 'Firmar con la rúbrica dibujada',
    description:
      'rubric es un PNG (data URL o base64) de máximo 64 KB. Consume el enlace. Errores: 403 SIGNATURE_IDENTITY_REQUIRED (sin identityToken vigente), 410 SIGNATURE_LINK_UNAVAILABLE, 400 VALIDATION_FAILED (rúbrica), 409 DOCUMENT_TAMPERED.',
  })
  @ApiOkResponse({ schema: envelopedSchema(SigningLinkResultResponseDto) })
  sign(
    @Param() params: SigningLinkParams,
    @Body() dto: SignByLinkDto,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string | undefined,
  ) {
    const rubric = Buffer.from(dto.rubric.replace(/^data:image\/png;base64,/, ''), 'base64');
    return this.engine.signByLink(params.token, dto.identityToken, rubric, {
      ipAddress: ipAddress || null,
      userAgent: userAgent ?? null,
    });
  }

  @Post(':token/reject')
  @HttpCode(200)
  @Public()
  @Throttle(ACTION_THROTTLE)
  @ApiOperation({ summary: 'Rechazar el acta, con motivo', description: 'Consume el enlace. Mismos errores que sign.' })
  @ApiOkResponse({ schema: envelopedSchema(SigningLinkResultResponseDto) })
  reject(
    @Param() params: SigningLinkParams,
    @Body() dto: RejectByLinkDto,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string | undefined,
  ) {
    return this.engine.rejectByLink(params.token, dto.identityToken, dto.reason, {
      ipAddress: ipAddress || null,
      userAgent: userAgent ?? null,
    });
  }
}
