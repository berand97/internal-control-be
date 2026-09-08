import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { AssetsModule } from '../assets/assets.module.js';
import { MovementsModule } from '../movements/movements.module.js';
import { QrTokenRotationLog } from './entities/qr-token-rotation-log.entity.js';
import { QrTokensController } from './qr-tokens.controller.js';
import { QrTokensService } from './services/qr-tokens.service.js';

@Module({
  imports: [
    AuthModule,
    AssetsModule,
    MovementsModule,
    TypeOrmModule.forFeature([QrTokenRotationLog]),
  ],
  controllers: [QrTokensController],
  providers: [QrTokensService],
})
export class QrTokensModule {}
