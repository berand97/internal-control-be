import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EmailAsset } from './entities/email-asset.entity.js';
import { EmailAssetUploadsService } from './email-asset-uploads.service.js';
import { EmailAssetsController } from './email-assets.controller.js';
import { EmailTemplatesModule } from './email-templates.module.js';

@Module({
  imports: [TypeOrmModule.forFeature([EmailAsset]), EmailTemplatesModule],
  controllers: [EmailAssetsController],
  providers: [EmailAssetUploadsService],
})
export class EmailAssetUploadsModule {}
