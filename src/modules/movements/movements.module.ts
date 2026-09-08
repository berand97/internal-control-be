import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { AssetMovement } from '../assets/entities/asset-movement.entity.js';
import { MovementVerificationLog } from './entities/movement-verification-log.entity.js';
import { MovementsVerifierJob } from './jobs/movements-verifier.job.js';
import { MovementsController } from './movements.controller.js';
import { MovementsService } from './services/movements.service.js';

@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([AssetMovement, MovementVerificationLog]),
  ],
  controllers: [MovementsController],
  providers: [MovementsService, MovementsVerifierJob],
  exports: [MovementsService],
})
export class MovementsModule {}
