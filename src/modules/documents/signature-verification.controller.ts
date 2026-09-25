import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Matches } from 'class-validator';
import { Public } from '../../common/decorators/public.decorator.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import { DocumentEngineService } from './services/document-engine.service.js';

export class VerificationCodeParams {
  @Matches(/^[A-Za-z0-9_-]{20,64}$/)
  readonly code!: string;
}

@ApiTags(OpenApiTag.DocumentTemplates)
@Controller('public/signatures')
export class SignatureVerificationController {
  constructor(private readonly engine: DocumentEngineService) {}

  @Get(':code')
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Verificación pública de una firma',
    description:
      'Sin sesión. Devuelve solo la atestación: quién firmó, en qué rol, cuándo, y si el PDF sigue íntegro. Nunca el contenido del documento.',
  })
  verify(@Param() params: VerificationCodeParams) {
    return this.engine.attestation(params.code);
  }
}
