import { Module } from '@nestjs/common';
import { StorageModule } from '../../shared/storage/storage.module.js';
import { AssetsModule } from '../assets/assets.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ImportTemplatesController } from './import-templates.controller.js';
import { ImportsController } from './imports.controller.js';
import { ExcelImportService } from './services/excel-import.service.js';
import { StagingDiagnosticsService } from './services/staging-diagnostics.service.js';
import { StagingLoaderService } from './services/staging-loader.service.js';
import { ImportTemplateService } from './templates/import-template.service.js';

@Module({
  // StorageModule es global en la aplicación; se importa explícito para que el CLI de staging y los tests que
  // montan solo este módulo también tengan StorageService (las plantillas se guardan en el storage).
  imports: [AuthModule, AssetsModule, StorageModule],
  controllers: [ImportsController, ImportTemplatesController],
  providers: [StagingLoaderService, StagingDiagnosticsService, ExcelImportService, ImportTemplateService],
  exports: [StagingLoaderService, StagingDiagnosticsService, ExcelImportService, ImportTemplateService],
})
export class StagingModule {}
