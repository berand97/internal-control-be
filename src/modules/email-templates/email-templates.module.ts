import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EmailAsset } from './entities/email-asset.entity.js';
import { EmailTemplate } from './entities/email-template.entity.js';
import { EmailAssetsService } from './email-assets.service.js';
import { EmailAssetsPublicController } from './email-assets-public.controller.js';
import { EmailTemplateTestSendService } from './email-template-test-send.service.js';
import { EmailTemplatesController } from './email-templates.controller.js';
import { EmailTemplatesService } from './email-templates.service.js';

/**
 * Plantillas de correo (contenido por bloques, versiones, vista previa, render HTML + texto). MailModule lo importa
 * porque MailService le pide el correo renderizado; el correo de prueba usa MailOutboxService, que llega por
 * MailModule (global) sin que este módulo lo importe: no hay ciclo de módulos. Las imágenes subidas (email_asset)
 * se sirven sin sesión por EmailAssetsPublicController, fuera del módulo Correo: un correo ya enviado las sigue
 * mostrando aunque el módulo se apague.
 */
@Module({
  imports: [TypeOrmModule.forFeature([EmailTemplate, EmailAsset])],
  controllers: [EmailTemplatesController, EmailAssetsPublicController],
  providers: [EmailTemplatesService, EmailTemplateTestSendService, EmailAssetsService],
  exports: [EmailTemplatesService],
})
export class EmailTemplatesModule {}
