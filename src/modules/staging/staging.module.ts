import { Module } from '@nestjs/common';
import { StagingDiagnosticsService } from './services/staging-diagnostics.service.js';
import { StagingLoaderService } from './services/staging-loader.service.js';

@Module({
  providers: [StagingLoaderService, StagingDiagnosticsService],
  exports: [StagingLoaderService, StagingDiagnosticsService],
})
export class StagingModule {}
