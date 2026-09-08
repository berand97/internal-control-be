import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { DocumentTemplatesController } from './document-templates.controller.js';
import {
  DocumentTemplate,
  GeneratedDocument,
} from './entities/document-template.entity.js';
import { DocumentTemplatesService } from './services/document-templates.service.js';

@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([DocumentTemplate, GeneratedDocument]),
  ],
  controllers: [DocumentTemplatesController],
  providers: [DocumentTemplatesService],
  exports: [DocumentTemplatesService],
})
export class DocumentTemplatesModule {}
