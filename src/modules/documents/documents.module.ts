import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { RolesModule } from '../roles/roles.module.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentRequestsJob } from './jobs/document-requests.job.js';
import { GotenbergPdfConverter, PDF_CONVERTER } from './pdf/pdf-converter.js';
import { DocumentEngineService } from './services/document-engine.service.js';
import { SIGNATURE_PROVIDER, StubSignatureProvider } from './signature/signature-provider.js';

@Module({
  imports: [AuthModule, RolesModule],
  controllers: [DocumentsController],
  providers: [
    DocumentEngineService,
    DocumentRequestsJob,
    StubSignatureProvider,
    { provide: PDF_CONVERTER, useClass: GotenbergPdfConverter },
    { provide: SIGNATURE_PROVIDER, useExisting: StubSignatureProvider },
  ],
  exports: [DocumentEngineService],
})
export class DocumentsModule {}
