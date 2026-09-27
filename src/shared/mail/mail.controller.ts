import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Feature } from '../../common/decorators/feature.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import {
  ApiErrorEnvelope,
  ApiSuccessEnvelope,
} from '../../common/swagger/api-envelopes.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';
import {
  MailSettingsResponseDto,
  MailTestResponseDto,
  MailVerifyResponseDto,
} from './dto/mail-settings.response.dto.js';
import { TestMailDto, UpdateMailSettingsDto } from './dto/update-mail-settings.dto.js';
import { MailService } from './mail.service.js';

/** SMTP. Las plantillas de correo se administran en /email-templates (src/modules/email-templates). */
@ApiTags(OpenApiTag.Mail)
@ApiBearerAuth()
@ApiExtraModels(
  ApiSuccessEnvelope,
  ApiErrorEnvelope,
  MailSettingsResponseDto,
  MailTestResponseDto,
  MailVerifyResponseDto,
)
@Feature('mail')
@Controller('mail')
export class MailController {
  constructor(private readonly mailService: MailService) {}

  @Get('settings')
  @RequirePermission('mail:manage:global')
  @ApiOperation({ summary: 'Leer la configuración SMTP' })
  settings(): Promise<MailSettingsResponseDto> {
    return this.mailService.getSettings();
  }

  @Patch('settings')
  @RequirePermission('mail:manage:global')
  @ApiOperation({ summary: 'Guardar la configuración SMTP' })
  updateSettings(
    @Body() dto: UpdateMailSettingsDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<MailSettingsResponseDto> {
    return this.mailService.updateSettings(dto, actor.id);
  }

  @Post('test-connection')
  @RequirePermission('mail:manage:global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Probar conexión SMTP',
    description: 'Conecta, hace EHLO y autentica. No envía correo.',
  })
  testConnection(): Promise<MailVerifyResponseDto> {
    return this.mailService.verifyConnection();
  }

  @Post('test')
  @RequirePermission('mail:manage:global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Enviar un correo de prueba con el SMTP guardado' })
  test(@Body() dto: TestMailDto): Promise<MailTestResponseDto> {
    return this.mailService.testConnection(dto.to);
  }
}
