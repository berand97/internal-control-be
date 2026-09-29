import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { AppUser } from '../auth/entities/app-user.entity.js';
import { AssetsModule } from '../assets/assets.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { Asset } from '../assets/entities/asset.entity.js';
import { CostCenter } from '../cost-centers/entities/cost-center.entity.js';
import { Location } from '../locations/entities/location.entity.js';
import { MailModule } from '../../shared/mail/mail.module.js';
import { MovementsModule } from '../movements/movements.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { OrganizationalUnit } from '../organizational-units/entities/organizational-unit.entity.js';
import { RolesModule } from '../roles/roles.module.js';
import { InventoryFindingCategory } from './entities/inventory-finding-category.entity.js';
import { InventoryItemCorrection } from './entities/inventory-item-correction.entity.js';
import { InventoryMissingCause } from './entities/inventory-missing-cause.entity.js';
import { PhysicalInventoryItem } from './entities/physical-inventory-item.entity.js';
import { PhysicalInventoryScope } from './entities/physical-inventory-scope.entity.js';
import { PhysicalInventory } from './entities/physical-inventory.entity.js';
import { AccountingCutsController } from './accounting-cuts.controller.js';
import { InventoriesController } from './inventories.controller.js';
import { InventoryCatalogsController } from './inventory-catalogs.controller.js';
import { InventoryRemindersJob } from './jobs/inventory-reminders.job.js';
import { AccountingCutsService } from './services/accounting-cuts.service.js';
import { InventoriesService } from './services/inventories.service.js';
import { InventoryActService } from './services/inventory-act.service.js';
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
import { InventorySchedulesService } from './services/inventory-schedules.service.js';

@Module({
  imports: [
    AuthModule,
    AssetsModule,
    DocumentsModule,
    MovementsModule,
    MailModule,
    NotificationsModule,
    RolesModule,
    TypeOrmModule.forFeature([
      PhysicalInventory,
      PhysicalInventoryItem,
      PhysicalInventoryScope,
      InventoryFindingCategory,
      InventoryMissingCause,
      InventoryItemCorrection,
      Asset,
      AppUser,
      CostCenter,
      Location,
      OrganizationalUnit,
    ]),
  ],
  // El de catálogos va primero: sus rutas fijas (/inventories/catalogs/...) no deben caer en /inventories/:id.
  controllers: [InventoryCatalogsController, InventoriesController, AccountingCutsController],
  providers: [
    InventoriesService,
    InventoryActorPolicy,
    InventoryReadAccess,
    InventoryCatalogsService,
    InventoryCorrectionsService,
    InventoryConflictsService,
    InventoryNoticesService,
    InventoryRemindersService,
    InventorySchedulesService,
    InventoryResponsibleCandidatesService,
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
