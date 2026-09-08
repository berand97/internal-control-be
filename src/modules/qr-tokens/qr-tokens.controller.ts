import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Feature } from '../../common/decorators/feature.decorator.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import {
  ApiErrorEnvelope,
  ApiSuccessEnvelope,
  envelopedSchema,
} from '../../common/swagger/api-envelopes.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';
import { ErrorCode } from '../../common/constants/error-code.enum.js';
import { ApiException } from '../../common/exceptions/api.exception.js';
import {
  QrHistoryItemDto,
  QrTokenResponseDto,
  QrVerifyAuthResponseDto,
  QrVerifyPublicResponseDto,
} from './dto/responses/qr-token.response.dto.js';
import { VerifyQrBodyDto, VerifyQrQueryDto } from './dto/verify-qr.dto.js';
import { QrTokensService } from './services/qr-tokens.service.js';

const PUBLIC_QR_THROTTLE = { default: { limit: 60, ttl: 60_000 } } as const;

@ApiTags(OpenApiTag.QrTokens)
@ApiExtraModels(
  ApiSuccessEnvelope,
  ApiErrorEnvelope,
  QrTokenResponseDto,
  QrVerifyPublicResponseDto,
  QrVerifyAuthResponseDto,
  QrHistoryItemDto,
)
@Feature('qr-tokens')
@Controller()
export class QrTokensController {
  constructor(private readonly qrTokensService: QrTokensService) {}

  @Post('assets/:assetId/qr')
  @ApiBearerAuth()
  @RequirePermission('asset:sign_qr:global')
  @ApiOperation({ summary: 'Generar o rotar QR del activo' })
  @ApiResponse({ status: 201, schema: envelopedSchema(QrTokenResponseDto) })
  issue(
    @Param('assetId', new ParseUUIDPipe({ version: '4' })) assetId: string,
    @Query() query: VerifyQrQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<QrTokenResponseDto> {
    return this.qrTokensService.issue(
      assetId,
      user,
      query.format === 'png',
      query.size ?? 300,
    );
  }

  @Get('assets/:assetId/qr/current')
  @ApiBearerAuth()
  @RequirePermission('asset:read:global')
  @ApiOperation({ summary: 'QR actual sin rotar' })
  current(
    @Param('assetId', new ParseUUIDPipe({ version: '4' })) assetId: string,
    @Query() query: VerifyQrQueryDto,
  ): Promise<QrTokenResponseDto> {
    return this.qrTokensService.current(
      assetId,
      query.format === 'png',
      query.size ?? 300,
    );
  }

  @Post('assets/:assetId/qr/revoke')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @RequirePermission('asset:sign_qr:global')
  @ApiOperation({ summary: 'Invalidar QR actual' })
  @ApiResponse({
    status: 200,
    schema: { $ref: getSchemaPath(ApiSuccessEnvelope) },
  })
  revoke(
    @Param('assetId', new ParseUUIDPipe({ version: '4' })) assetId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<null> {
    return this.qrTokensService.revoke(assetId, user);
  }

  @Get('assets/:assetId/qr/history')
  @ApiBearerAuth()
  @RequirePermission('asset:read:global')
  @ApiOperation({ summary: 'Historial de rotaciones de QR' })
  history(
    @Param('assetId', new ParseUUIDPipe({ version: '4' })) assetId: string,
  ): Promise<ReadonlyArray<QrHistoryItemDto>> {
    return this.qrTokensService.history(assetId);
  }

  @Get('qr/verify')
  @Public()
  @Throttle(PUBLIC_QR_THROTTLE)
  @ApiOperation({
    summary: 'Verificar QR (público)',
    description: 'Sin datos de responsable ni precio. Rate limit 60/min por IP.',
  })
  verifyPublicGet(
    @Query() query: VerifyQrQueryDto,
  ): Promise<QrVerifyPublicResponseDto> {
    if (!query.token) {
      throw new ApiException(ErrorCode.QrTokenInvalid);
    }
    return this.qrTokensService.verifyPublic(
      query.token,
      query.format === 'png',
      query.size ?? 300,
    );
  }

  @Post('qr/verify')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @RequirePermission('asset:read:global')
  @ApiOperation({ summary: 'Verificar QR autenticado (incluye préstamos y movimientos)' })
  verifyAuth(
    @Body() dto: VerifyQrBodyDto,
  ): Promise<QrVerifyAuthResponseDto> {
    return this.qrTokensService.verifyAuthenticated(dto.token);
  }
}
