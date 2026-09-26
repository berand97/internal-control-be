import { Module } from '@nestjs/common';
import { MailModule } from '../../shared/mail/mail.module.js';
import { StorageModule } from '../../shared/storage/storage.module.js';
import { AssetsModule } from '../assets/assets.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { MovementsModule } from '../movements/movements.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { ImportTemplatesController } from './import-templates.controller.js';
import { ImportsController } from './imports.controller.js';
import { ImportJobsJob } from './jobs/import-jobs.job.js';
import { ExcelImportService } from './services/excel-import.service.js';
import { ImportJobsService } from './services/import-jobs.service.js';
import { StagingDiagnosticsService } from './services/staging-diagnostics.service.js';
import { StagingLoaderService } from './services/staging-loader.service.js';
import { ImportTemplateService } from './templates/import-template.service.js';

@Module({
  // StorageModule es global en la aplicación; se importa explícito para que el CLI de staging y los tests que
  // montan solo este módulo también tengan StorageService (las plantillas se guardan en el storage).
  imports: [AuthModule, AssetsModule, MovementsModule, MailModule, NotificationsModule, StorageModule],
  controllers: [ImportsController, ImportTemplatesController],
  providers: [StagingLoaderService, StagingDiagnosticsService, ExcelImportService, ImportJobsService, ImportJobsJob, ImportTemplateService],
  exports: [StagingLoaderService, StagingDiagnosticsService, ExcelImportService, ImportJobsService, ImportTemplateService],
})
export class StagingModule {}
