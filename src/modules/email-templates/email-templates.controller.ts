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
  ApiCreatedResponse,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Feature } from '../../common/decorators/feature.decorator.js';
import { RequirePermission } from '../../common/decorators/require-permission.decorator.js';
import {
  ApiErrorEnvelope,
  ApiSuccessEnvelope,
  envelopedSchema,
} from '../../common/swagger/api-envelopes.js';
import { OpenApiTag } from '../../common/swagger/openapi-tags.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';
import {
  CreateEmailTemplateVersionDto,
  EMAIL_BLOCK_DTOS,
  EMAIL_RICH_TEXT_DTOS,
  KeyValueItemDto,
  ListEmailTemplatesQueryDto,
  PreviewEmailTemplateDto,
  SendTestEmailDto,
} from './dto/email-template.dto.js';
import {
  EmailBlockFieldSpecDto,
  EmailBlockSpecDto,
  EmailDesignLimitsDto,
  EmailPreviewResponseDto,
  EmailTemplateCatalogResponseDto,
  EmailTemplateTypeDto,
  EmailTemplateVersionResponseDto,
  EmailTestSendResponseDto,
  envelopedArraySchema,
} from './dto/email-template.responses.js';
import { EmailTemplateTestSendService } from './email-template-test-send.service.js';
import { EmailTemplatesService } from './email-templates.service.js';

const UUID_PIPE = new ParseUUIDPipe({ version: '4' });

/**
 * Plantillas de correo: lectura con email_template:read:global, cambios y correo de prueba con
 * email_template:manage:global. Ambos permisos los tiene por defecto INTERNAL_CONTROL_DIRECTOR, que los delega por
 * la administración de roles en cascada. Bajo el módulo "Correo" (feature mail): si se apaga, esto también.
 */
@ApiTags(OpenApiTag.Mail)
@ApiBearerAuth()
@ApiExtraModels(
  ApiSuccessEnvelope,
  ApiErrorEnvelope,
  ...EMAIL_BLOCK_DTOS,
  ...EMAIL_RICH_TEXT_DTOS,
  KeyValueItemDto,
  EmailBlockFieldSpecDto,
  EmailBlockSpecDto,
  EmailDesignLimitsDto,
  EmailTemplateTypeDto,
  EmailTemplateCatalogResponseDto,
  EmailTemplateVersionResponseDto,
  EmailPreviewResponseDto,
  EmailTestSendResponseDto,
)
@Feature('mail')
@Controller('email-templates')
export class EmailTemplatesController {
  constructor(
    private readonly templates: EmailTemplatesService,
    private readonly testSend: EmailTemplateTestSendService,
  ) {}

  @Get('catalog')
  @RequirePermission('email_template:read:global')
  @ApiOperation({
    summary: 'Tipos de correo con sus variables, catálogo de bloques y límites',
    description:
      'Los tipos son los correos que el sistema ya envía (fijos en código). Cada uno trae variables obligatorias y opcionales, datos de ejemplo, diseño por defecto y versión activa (null = diseño por defecto).',
  })
  @ApiOkResponse({ schema: envelopedSchema(EmailTemplateCatalogResponseDto) })
  catalog(): Promise<EmailTemplateCatalogResponseDto> {
    return this.templates.catalog();
  }

  @Get()
  @RequirePermission('email_template:read:global')
  @ApiOperation({ summary: 'Versiones de un tipo de correo, de la más nueva a la más vieja' })
  @ApiOkResponse({ schema: envelopedArraySchema(EmailTemplateVersionResponseDto) })
  list(@Query() query: ListEmailTemplatesQueryDto): Promise<ReadonlyArray<EmailTemplateVersionResponseDto>> {
    return this.templates.list(query.templateType);
  }

  @Post()
  @RequirePermission('email_template:manage:global')
  @ApiOperation({
    summary: 'Guardar una versión nueva (queda activa)',
    description:
      'Valida los bloques (catálogo cerrado, campos y longitudes; el párrafo es un documento Tiptap de esquema cerrado), que cada imagen exista, las variables del tipo (EMAIL_TEMPLATE_UNKNOWN_VARIABLE, EMAIL_TEMPLATE_MISSING_VARIABLE) y los URL de botón, enlace e imagen (variable o https://). Estructura inválida: EMAIL_TEMPLATE_INVALID_DESIGN con details[].field = ruta exacta (blocks[i].campo, blocks[i].content.content[j]..., blocks[i].assetId).',
  })
  @ApiCreatedResponse({ schema: envelopedSchema(EmailTemplateVersionResponseDto) })
  create(
    @Body() dto: CreateEmailTemplateVersionDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<EmailTemplateVersionResponseDto> {
    return this.templates.create(dto.templateType, dto.subject, dto.blocks, actor.id);
  }

  @Post('preview')
  @RequirePermission('email_template:read:global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Vista previa de un borrador con datos de ejemplo (no guarda ni envía)',
    description: 'Mismas validaciones que guardar. Devuelve el HTML completo (con el layout institucional) y el texto plano.',
  })
  @ApiOkResponse({ schema: envelopedSchema(EmailPreviewResponseDto) })
  preview(@Body() dto: PreviewEmailTemplateDto): Promise<EmailPreviewResponseDto> {
    return this.templates.preview(dto.templateType, dto.subject, dto.blocks);
  }

  @Post('test-send')
  @RequirePermission('email_template:manage:global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Enviar un correo de prueba al usuario actual (por el outbox de correo)',
    description:
      'Usa los datos de ejemplo del tipo y la versión indicada (o la activa, o el diseño por defecto). Se intenta enviar enseguida: sin SMTP configurado queda FAILED con lastError y se reintenta como cualquier correo del outbox.',
  })
  @ApiOkResponse({ schema: envelopedSchema(EmailTestSendResponseDto) })
  sendTest(
    @Body() dto: SendTestEmailDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<EmailTestSendResponseDto> {
    return this.testSend.send(actor.id, dto.templateType, dto.templateId ?? null);
  }

  @Get(':id/preview')
  @RequirePermission('email_template:read:global')
  @ApiOperation({ summary: 'Vista previa de una versión guardada con datos de ejemplo' })
  @ApiOkResponse({ schema: envelopedSchema(EmailPreviewResponseDto) })
  previewVersion(@Param('id', UUID_PIPE) id: string): Promise<EmailPreviewResponseDto> {
    return this.templates.previewVersion(id);
  }

  @Post(':id/activate')
  @RequirePermission('email_template:manage:global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Activar una versión (desactiva la que estaba activa en ese tipo)' })
  @ApiOkResponse({ schema: envelopedSchema(EmailTemplateVersionResponseDto) })
  activate(
    @Param('id', UUID_PIPE) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<EmailTemplateVersionResponseDto> {
    return this.templates.activate(id, actor.id);
  }
}
