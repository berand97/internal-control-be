import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
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
import {
  EmailPreviewDto,
  EmailTemplateResponseDto,
  SaveEmailTemplateDto,
} from './dto/email-template.dto.js';
import { TestMailDto, UpdateMailSettingsDto } from './dto/update-mail-settings.dto.js';
import { isEmailTemplateType } from './domain/email-template-catalog.js';
import { EmailTemplatesService } from './email-templates.service.js';
import { MailService } from './mail.service.js';

@ApiTags(OpenApiTag.Mail)
@ApiBearerAuth()
@ApiExtraModels(
  ApiSuccessEnvelope,
  ApiErrorEnvelope,
  MailSettingsResponseDto,
  MailTestResponseDto,
  MailVerifyResponseDto,
  EmailTemplateResponseDto,
)
@Feature('mail')
@Controller('mail')
export class MailController {
  constructor(
    private readonly mailService: MailService,
    private readonly emailTemplates: EmailTemplatesService,
  ) {}

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

  @Get('templates/catalog')
  @RequirePermission('mail:manage:global')
  @ApiOperation({ summary: 'Catálogo de tokens de plantillas de correo' })
  catalog() {
    return this.emailTemplates.catalog();
  }

  @Get('templates')
  @RequirePermission('mail:manage:global')
  @ApiOperation({ summary: 'Versiones de una plantilla de correo' })
  listTemplates(@Query('templateType') templateType?: string) {
    if (!templateType || !isEmailTemplateType(templateType)) {
      return this.emailTemplates.list('USER_INVITATION');
    }
    return this.emailTemplates.list(templateType);
  }

  @Put('templates')
  @RequirePermission('mail:manage:global')
  @ApiOperation({ summary: 'Guardar una nueva versión de plantilla de correo' })
  saveTemplate(
    @Body() dto: SaveEmailTemplateDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.emailTemplates.save(dto.templateType, dto.subject, dto.body, actor.id);
  }

  @Post('templates/preview')
  @RequirePermission('mail:manage:global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Vista previa con tokens de ejemplo' })
  preview(@Body() dto: EmailPreviewDto) {
    return this.emailTemplates.preview(dto.templateType, dto.subject, dto.body);
  }

  @Post('templates/:id/activate')
  @RequirePermission('mail:manage:global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Activar una versión de plantilla' })
  activate(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.emailTemplates.activate(id, actor.id);
  }
}
