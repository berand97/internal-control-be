import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { Asset } from '../assets/entities/asset.entity.js';
import { AssetDepreciationController } from './asset-depreciation.controller.js';
import { DepreciationController } from './depreciation.controller.js';
import { AssetDepreciation } from './entities/asset-depreciation.entity.js';
import { MonthlyDepreciationJob } from './jobs/monthly-depreciation.job.js';
import { DepreciationService } from './services/depreciation.service.js';

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([AssetDepreciation, Asset])],
  controllers: [DepreciationController, AssetDepreciationController],
  providers: [DepreciationService, MonthlyDepreciationJob],
  exports: [DepreciationService],
})
export class DepreciationModule {}
