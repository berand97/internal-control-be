import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FeatureFlag } from './entities/feature-flag.entity.js';
import { FeaturesController } from './features.controller.js';
import { FeatureFlagsService } from './services/feature-flags.service.js';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([FeatureFlag])],
  controllers: [FeaturesController],
  providers: [FeatureFlagsService],
  exports: [FeatureFlagsService],
})
export class FeaturesModule {}
