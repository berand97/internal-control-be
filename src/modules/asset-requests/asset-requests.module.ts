import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { LoansModule } from '../loans/loans.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { QrTokensModule } from '../qr-tokens/qr-tokens.module.js';
import { RolesModule } from '../roles/roles.module.js';
import { TransfersModule } from '../transfers/transfers.module.js';
import { AssetRequestsController } from './asset-requests.controller.js';
import { AssetRequestExpiryJob } from './jobs/asset-request-expiry.job.js';
import { AssetRequestCompletionObserver } from './services/asset-request-completion.observer.js';
import { AssetRequestNoticesService } from './services/asset-request-notices.service.js';
import { AssetRequestsService } from './services/asset-requests.service.js';

@Module({
  imports: [AuthModule, DocumentsModule, LoansModule, NotificationsModule, QrTokensModule, RolesModule, TransfersModule],
  controllers: [AssetRequestsController],
  providers: [AssetRequestsService, AssetRequestNoticesService, AssetRequestCompletionObserver, AssetRequestExpiryJob],
})
export class AssetRequestsModule {}
