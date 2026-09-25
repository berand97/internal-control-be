import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration.js';
import { AuthModule } from '../auth/auth.module.js';
import { RolesModule } from '../roles/roles.module.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentRequestsJob } from './jobs/document-requests.job.js';
import { DocumentLifecycleRegistry } from './lifecycle/document-lifecycle.registry.js';
import { GotenbergPdfConverter, PDF_CONVERTER } from './pdf/pdf-converter.js';
import { DocumentEngineService } from './services/document-engine.service.js';
import { DocumentListService } from './services/document-list.service.js';
import { InternalSignatureProvider } from './signature/internal-signature.provider.js';
import { SIGNATURE_PROVIDER, StubSignatureProvider } from './signature/signature-provider.js';
import { SignatureVerificationController } from './signature-verification.controller.js';

@Module({
  imports: [AuthModule, RolesModule],
  controllers: [DocumentsController, SignatureVerificationController],
  providers: [
    DocumentEngineService,
    DocumentLifecycleRegistry,
    DocumentListService,
    DocumentRequestsJob,
    StubSignatureProvider,
    InternalSignatureProvider,
    { provide: PDF_CONVERTER, useClass: GotenbergPdfConverter },
    {
      provide: SIGNATURE_PROVIDER,
      inject: [ConfigService, InternalSignatureProvider, StubSignatureProvider],
      useFactory: (
        config: ConfigService<AppConfig, true>,
        internal: InternalSignatureProvider,
        stub: StubSignatureProvider,
      ) => (config.getOrThrow('documents', { infer: true }).signatureProvider === 'stub' ? stub : internal),
    },
  ],
  exports: [DocumentEngineService, DocumentLifecycleRegistry],
})
export class DocumentsModule {}
