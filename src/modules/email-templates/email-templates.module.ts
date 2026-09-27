import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EmailTemplate } from './entities/email-template.entity.js';
import { EmailTemplateTestSendService } from './email-template-test-send.service.js';
import { EmailTemplatesController } from './email-templates.controller.js';
import { EmailTemplatesService } from './email-templates.service.js';

/**
 * Plantillas de correo (contenido por bloques, versiones, vista previa, render HTML + texto). MailModule lo importa
 * porque MailService le pide el correo renderizado; el correo de prueba usa MailOutboxService, que llega por
 * MailModule (global) sin que este módulo lo importe: no hay ciclo de módulos.
 */
@Module({
  imports: [TypeOrmModule.forFeature([EmailTemplate])],
  controllers: [EmailTemplatesController],
  providers: [EmailTemplatesService, EmailTemplateTestSendService],
  exports: [EmailTemplatesService],
})
export class EmailTemplatesModule {}
