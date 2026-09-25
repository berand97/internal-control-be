import { Module } from '@nestjs/common';
import { AssetsModule } from '../assets/assets.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { HandoversController } from './handovers.controller.js';
import { HandoversService } from './services/handovers.service.js';

@Module({
  imports: [AssetsModule, DocumentsModule],
  controllers: [HandoversController],
  providers: [HandoversService],
})
export class HandoversModule {}
