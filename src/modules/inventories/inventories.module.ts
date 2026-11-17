import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { AppUser } from '../auth/entities/app-user.entity.js';
import { AssetsModule } from '../assets/assets.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { FeaturesModule } from '../features/features.module.js';
import { Asset } from '../assets/entities/asset.entity.js';
import { CostCenter } from '../cost-centers/entities/cost-center.entity.js';
import { Location } from '../locations/entities/location.entity.js';
import { MailModule } from '../../shared/mail/mail.module.js';
import { StorageModule } from '../../shared/storage/storage.module.js';
import { MovementsModule } from '../movements/movements.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { OrganizationalUnit } from '../organizational-units/entities/organizational-unit.entity.js';
import { RolesModule } from '../roles/roles.module.js';
import { InventoryFindingCategory } from './entities/inventory-finding-category.entity.js';
import { InventoryItemCorrection } from './entities/inventory-item-correction.entity.js';
import { InventoryMissingCause } from './entities/inventory-missing-cause.entity.js';
import { PhysicalInventoryItem } from './entities/physical-inventory-item.entity.js';
import { PhysicalInventoryScope } from './entities/physical-inventory-scope.entity.js';
import { PhysicalInventoryAct } from './entities/physical-inventory-act.entity.js';
import { PhysicalInventory } from './entities/physical-inventory.entity.js';
import { AccountingCutsController } from './accounting-cuts.controller.js';
import { InventoriesController } from './inventories.controller.js';
import { InventoryCatalogsController } from './inventory-catalogs.controller.js';
import { InventoryRemindersJob } from './jobs/inventory-reminders.job.js';
import { AccountingCutsService } from './services/accounting-cuts.service.js';
import { InventoriesService } from './services/inventories.service.js';
import { InventoryActService } from './services/inventory-act.service.js';
import { InventoryAssetEffectsService } from './services/inventory-asset-effects.service.js';
import { InventorySignerHeadService } from './services/inventory-signer-head.service.js';
import { InventorySurplusService } from './services/inventory-surplus.service.js';
import { InventoryValuationService } from './services/inventory-valuation.service.js';
import { InventoryActorPolicy } from './services/inventory-actor-policy.service.js';
import { InventoryReadAccess } from './services/inventory-read-access.service.js';
import { InventoryCatalogsService } from './services/inventory-catalogs.service.js';
import { InventoryCorrectionsService } from './services/inventory-corrections.service.js';
import { InventoryConflictsService } from './services/inventory-conflicts.service.js';
import { InventoryNoticesService } from './services/inventory-notices.service.js';
import { InventoryPlanningService } from './services/inventory-planning.service.js';
import { InventoryRemindersService } from './services/inventory-reminders.service.js';
import { InventoryResponsibleCandidatesService } from './services/inventory-responsible-candidates.service.js';
import { InventoryScopeHeadsService } from './services/inventory-scope-heads.service.js';
import { InventorySchedulesService } from './services/inventory-schedules.service.js';
import { InventoryMetricsService } from './services/inventory-metrics.service.js';
import { InventoryItemPhoto } from './entities/inventory-item-photo.entity.js';
import { InventoryItemPhotosService } from './services/inventory-item-photos.service.js';
import { DashboardController } from './dashboard.controller.js';
import { InventoryLocationCompanion } from './entities/inventory-location-companion.entity.js';
import { PhysicalInventoryActAgreement } from './entities/physical-inventory-act-agreement.entity.js';
import { InventoryActAgreementLink } from './entities/inventory-act-agreement-link.entity.js';
import { InventoryLocationCompanionService } from './services/inventory-location-companion.service.js';
import { InventoryActAgreementService } from './services/inventory-act-agreement.service.js';
import { InventoryAgreementPublicController } from './inventory-agreement-public.controller.js';

@Module({
  imports: [
    AuthModule,
    AssetsModule,
    DocumentsModule,
    FeaturesModule,
    MovementsModule,
    MailModule,
    StorageModule,
    NotificationsModule,
    RolesModule,
    TypeOrmModule.forFeature([
      PhysicalInventory,
      PhysicalInventoryItem,
      PhysicalInventoryScope,
      PhysicalInventoryAct,
      InventoryFindingCategory,
      InventoryMissingCause,
      InventoryItemCorrection,
      InventoryItemPhoto,
      InventoryLocationCompanion,
      PhysicalInventoryActAgreement,
      InventoryActAgreementLink,
      Asset,
      AppUser,
      CostCenter,
      Location,
      OrganizationalUnit,
    ]),
  ],
  controllers: [
    InventoryCatalogsController,
    InventoriesController,
    AccountingCutsController,
    DashboardController,
    InventoryAgreementPublicController,
  ],
  providers: [
    InventoriesService,
    InventoryMetricsService,
    InventoryItemPhotosService,
    InventoryLocationCompanionService,
    InventoryActAgreementService,
    InventoryAssetEffectsService,
    InventoryActorPolicy,
    InventoryReadAccess,
    InventoryCatalogsService,
    InventoryCorrectionsService,
    InventoryConflictsService,
    InventoryNoticesService,
    InventoryRemindersService,
    InventorySchedulesService,
    InventoryResponsibleCandidatesService,
    InventoryScopeHeadsService,
    InventoryPlanningService,
    InventoryRemindersJob,
    InventoryValuationService,
    InventoryActService,
    InventorySignerHeadService,
    InventorySurplusService,
    AccountingCutsService,
  ],
  exports: [InventoriesService, InventorySchedulesService, InventoryRemindersService, InventoryPlanningService],
})
export class InventoriesModule {}
