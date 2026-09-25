import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { AppUser } from '../auth/entities/app-user.entity.js';
import { AssetsModule } from '../assets/assets.module.js';
import { Asset } from '../assets/entities/asset.entity.js';
import { CostCenter } from '../cost-centers/entities/cost-center.entity.js';
import { Location } from '../locations/entities/location.entity.js';
import { MovementsModule } from '../movements/movements.module.js';
import { OrganizationalUnit } from '../organizational-units/entities/organizational-unit.entity.js';
import { RolesModule } from '../roles/roles.module.js';
import { PhysicalInventoryItem } from './entities/physical-inventory-item.entity.js';
import { PhysicalInventoryScope } from './entities/physical-inventory-scope.entity.js';
import { PhysicalInventory } from './entities/physical-inventory.entity.js';
import { InventoriesController } from './inventories.controller.js';
import { InventoriesService } from './services/inventories.service.js';

@Module({
  imports: [
    AuthModule,
    AssetsModule,
    MovementsModule,
    RolesModule,
    TypeOrmModule.forFeature([
      PhysicalInventory,
      PhysicalInventoryItem,
      PhysicalInventoryScope,
      Asset,
      AppUser,
      CostCenter,
      Location,
      OrganizationalUnit,
    ]),
  ],
  controllers: [InventoriesController],
  providers: [InventoriesService],
  exports: [InventoriesService],
})
export class InventoriesModule {}
