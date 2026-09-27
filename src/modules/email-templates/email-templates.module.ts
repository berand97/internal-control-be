import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EmailAsset } from './entities/email-asset.entity.js';
import { EmailTemplate } from './entities/email-template.entity.js';
import { EmailAssetsService } from './email-assets.service.js';
import { EmailTemplateTestSendService } from './email-template-test-send.service.js';
import { EmailTemplatesController } from './email-templates.controller.js';
import { EmailTemplatesService } from './email-templates.service.js';

/**
 * Plantillas de correo (contenido por bloques, versiones, vista previa, render HTML + texto). MailModule lo importa
 * porque MailService le pide el correo renderizado; el correo de prueba usa MailOutboxService, que llega por
 * MailModule (global) sin que este módulo lo importe: no hay ciclo de módulos. Las imágenes subidas (email_asset) van
 * al bucket público del proveedor S3 y los correos las cargan desde allí: el backend no sirve sus bytes.
 */
@Module({
  imports: [TypeOrmModule.forFeature([EmailTemplate, EmailAsset])],
  controllers: [EmailTemplatesController],
  providers: [EmailTemplatesService, EmailTemplateTestSendService, EmailAssetsService],
  exports: [EmailTemplatesService],
})
export class EmailTemplatesModule {}
