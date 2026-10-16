import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EmailTemplatesModule } from '../../modules/email-templates/email-templates.module.js';
import { CryptoModule } from '../crypto/crypto.module.js';
import { MailSettings } from './entities/mail-settings.entity.js';
import { MailOutboxService } from './mail-outbox.service.js';
import { MailController } from './mail.controller.js';
import { MailService } from './mail.service.js';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([MailSettings]), CryptoModule, EmailTemplatesModule],
  controllers: [MailController],
  providers: [MailService, MailOutboxService],
  exports: [MailService, MailOutboxService],
})
export class MailModule {}
