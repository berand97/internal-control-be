import { Module } from '@nestjs/common';
import { AssetsModule } from '../assets/assets.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ImportsController } from './imports.controller.js';
import { ExcelImportService } from './services/excel-import.service.js';
import { StagingDiagnosticsService } from './services/staging-diagnostics.service.js';
import { StagingLoaderService } from './services/staging-loader.service.js';

@Module({
  imports: [AuthModule, AssetsModule],
  controllers: [ImportsController],
  providers: [StagingLoaderService, StagingDiagnosticsService, ExcelImportService],
  exports: [StagingLoaderService, StagingDiagnosticsService, ExcelImportService],
})
export class StagingModule {}
