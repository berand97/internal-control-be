import { Module } from '@nestjs/common';
import { AssetsModule } from '../assets/assets.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { RolesModule } from '../roles/roles.module.js';
import { TransferActLifecycle } from './services/transfer-act.lifecycle.js';
import { TransferReasonsService } from './services/transfer-reasons.service.js';
import { TransferSignersService } from './services/transfer-signers.service.js';
import { TransfersService } from './services/transfers.service.js';
import { TransfersController } from './transfers.controller.js';

@Module({
  imports: [AuthModule, AssetsModule, DocumentsModule, RolesModule],
  controllers: [TransfersController],
  providers: [TransfersService, TransferReasonsService, TransferSignersService, TransferActLifecycle],
  exports: [TransfersService, TransferSignersService],
})
export class TransfersModule {}
