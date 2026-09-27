import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EmailAsset } from './entities/email-asset.entity.js';
import { EmailAssetUploadsService } from './email-asset-uploads.service.js';
import { EmailAssetsController } from './email-assets.controller.js';
import { EmailTemplatesModule } from './email-templates.module.js';

/**
 * Subida y lista de imágenes de correo (POST/GET /email-templates/assets). Módulo aparte porque la subida usa
 * StorageService (global en AppModule): si viviera en EmailTemplatesModule, que importa MailModule por la cadena
 * AuthModule → MailModule → EmailTemplatesModule, se formaría el ciclo StorageModule → AuthModule → ... → StorageModule.
 */
@Module({
  imports: [TypeOrmModule.forFeature([EmailAsset]), EmailTemplatesModule],
  controllers: [EmailAssetsController],
  providers: [EmailAssetUploadsService],
})
export class EmailAssetUploadsModule {}
