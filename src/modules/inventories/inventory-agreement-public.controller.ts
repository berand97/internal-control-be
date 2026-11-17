import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiExtraModels, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Matches } from 'class-validator';
import { Throttle } from '@nestjs/throttler';
import { Feature } from '../../common/decorators/feature.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { ApiSuccessEnvelope, envelopedSchema } from '../../common/swagger/api-envelopes.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import { ActAgreementResponseDto, RespondAgreementDto } from './dto/inventory-agreement.dto.js';
import { InventoryActAgreementService } from './services/inventory-act-agreement.service.js';

class AgreementLinkParams {
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  readonly token!: string;
}

const READ_THROTTLE = { default: { limit: 30, ttl: 60_000 } } as const;
const ACTION_THROTTLE = { default: { limit: 10, ttl: 60_000 } } as const;

@ApiTags(OpenApiTag.Inventories)
@ApiExtraModels(ApiSuccessEnvelope, ActAgreementResponseDto)
@Feature('inventories')
@Controller('public/inventory-agreements')
export class InventoryAgreementPublicController {
  constructor(private readonly agreements: InventoryActAgreementService) {}

  @Get(':token')
  @Public()
  @Throttle(READ_THROTTLE)
  @ApiOperation({ summary: 'Resumen de conformidad del jefe (enlace firmado)' })
  @ApiOkResponse({ schema: envelopedSchema(ActAgreementResponseDto) })
  view(@Param() params: AgreementLinkParams) {
    return this.agreements.viewByToken(params.token);
  }

  @Post(':token')
  @Public()
  @Throttle(ACTION_THROTTLE)
  @ApiOperation({ summary: 'Responder conformidad (AGREED / OBJECTED) con el enlace' })
  @ApiOkResponse({ schema: envelopedSchema(ActAgreementResponseDto) })
  respond(@Param() params: AgreementLinkParams, @Body() dto: RespondAgreementDto) {
    return this.agreements.respondByToken(params.token, dto);
  }
}
