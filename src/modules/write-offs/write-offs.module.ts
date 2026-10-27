import { Module } from '@nestjs/common';
import { AssetsModule } from '../assets/assets.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { RolesModule } from '../roles/roles.module.js';
import { WriteOffActLifecycle } from './services/write-off-act.lifecycle.js';
import { WriteOffsService } from './services/write-offs.service.js';
import { WriteOffsController } from './write-offs.controller.js';

@Module({
  imports: [AuthModule, AssetsModule, DocumentsModule, RolesModule],
  controllers: [WriteOffsController],
  providers: [WriteOffsService, WriteOffActLifecycle],
  exports: [WriteOffsService],
})
export class WriteOffsModule {}
