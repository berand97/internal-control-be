import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EmailAsset } from './entities/email-asset.entity.js';
import { EmailTemplate } from './entities/email-template.entity.js';
import { EmailAssetsService } from './email-assets.service.js';
import { EmailTemplateTestSendService } from './email-template-test-send.service.js';
import { EmailTemplatesController } from './email-templates.controller.js';
import { EmailTemplatesService } from './email-templates.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([EmailTemplate, EmailAsset])],
  controllers: [EmailTemplatesController],
  providers: [EmailTemplatesService, EmailTemplateTestSendService, EmailAssetsService],
  exports: [EmailTemplatesService, EmailAssetsService],
})
export class EmailTemplatesModule {}
