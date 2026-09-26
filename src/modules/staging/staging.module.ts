import { Module } from '@nestjs/common';
import { MailModule } from '../../shared/mail/mail.module.js';
import { AssetsModule } from '../assets/assets.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { MovementsModule } from '../movements/movements.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { ImportsController } from './imports.controller.js';
import { ImportJobsJob } from './jobs/import-jobs.job.js';
import { ExcelImportService } from './services/excel-import.service.js';
import { ImportJobsService } from './services/import-jobs.service.js';
import { StagingDiagnosticsService } from './services/staging-diagnostics.service.js';
import { StagingLoaderService } from './services/staging-loader.service.js';

@Module({
  imports: [AuthModule, AssetsModule, MovementsModule, MailModule, NotificationsModule],
  controllers: [ImportsController],
  providers: [StagingLoaderService, StagingDiagnosticsService, ExcelImportService, ImportJobsService, ImportJobsJob],
  exports: [StagingLoaderService, StagingDiagnosticsService, ExcelImportService, ImportJobsService],
})
export class StagingModule {}
