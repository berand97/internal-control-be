import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Person } from '../auth/entities/person.entity.js';
import { AuthModule } from '../auth/auth.module.js';
import { Asset } from '../assets/entities/asset.entity.js';
import { AssetsModule } from '../assets/assets.module.js';
import { CostCenter } from '../cost-centers/entities/cost-center.entity.js';
import { CostCentersModule } from '../cost-centers/cost-centers.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { MovementsModule } from '../movements/movements.module.js';
import { RolesModule } from '../roles/roles.module.js';
import { ACTIVE_LOANS_PORT } from '../users/ports/active-loans.port.js';
import { LoansActiveLoansAdapter } from './adapters/loans-active-loans.adapter.js';
import { AssetLoan } from './entities/asset-loan.entity.js';
import {
  AssetLoanEvent,
  AssetLoanItem,
  LoanAttachment,
} from './entities/asset-loan-item.entity.js';
import { LoansOverdueCheckerJob } from './jobs/loans-overdue.job.js';
import { LoansController } from './loans.controller.js';
import { LoanDeliveryActLifecycle } from './services/loan-delivery-act.lifecycle.js';
import { LoansService } from './services/loans.service.js';

@Module({
  imports: [
    AuthModule,
    AssetsModule,
    CostCentersModule,
    MovementsModule,
    DocumentsModule,
    RolesModule,
    TypeOrmModule.forFeature([
      AssetLoan,
      AssetLoanItem,
      AssetLoanEvent,
      LoanAttachment,
      Asset,
      CostCenter,
      Person,
    ]),
  ],
  controllers: [LoansController],
  providers: [
    LoansService,
    LoanDeliveryActLifecycle,
    LoansOverdueCheckerJob,
    LoansActiveLoansAdapter,
    { provide: ACTIVE_LOANS_PORT, useExisting: LoansActiveLoansAdapter },
  ],
  exports: [LoansService, LoansActiveLoansAdapter, ACTIVE_LOANS_PORT],
})
export class LoansModule {}
