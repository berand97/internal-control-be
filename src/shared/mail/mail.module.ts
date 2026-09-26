import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CryptoModule } from '../crypto/crypto.module.js';
import { EmailTemplatesService } from './email-templates.service.js';
import { EmailTemplate } from './entities/email-template.entity.js';
import { MailSettings } from './entities/mail-settings.entity.js';
import { MailOutboxService } from './mail-outbox.service.js';
import { MailController } from './mail.controller.js';
import { MailService } from './mail.service.js';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([MailSettings, EmailTemplate]), CryptoModule],
  controllers: [MailController],
  providers: [MailService, EmailTemplatesService, MailOutboxService],
  exports: [MailService, EmailTemplatesService, MailOutboxService],
})
export class MailModule {}
