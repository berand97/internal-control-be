import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { AssetCategory } from '../categories/entities/asset-category.entity.js';
import { CategoriesModule } from '../categories/categories.module.js';
import { CostCenter } from '../cost-centers/entities/cost-center.entity.js';
import { CostCentersModule } from '../cost-centers/cost-centers.module.js';
import { DynamicFieldsModule } from '../dynamic-fields/dynamic-fields.module.js';
import { Location } from '../locations/entities/location.entity.js';
import { LocationsModule } from '../locations/locations.module.js';
import { MovementsModule } from '../movements/movements.module.js';
import { RolesModule } from '../roles/roles.module.js';
import { AssetReadScopeGuard } from './asset-read-scope.guard.js';
import { AssetPriceZeroController } from './asset-price-zero.controller.js';
import { AssetsController } from './assets.controller.js';
import { AcquisitionType } from './entities/acquisition-type.entity.js';
import { AssetCustomValue } from './entities/asset-custom-value.entity.js';
import { AssetIdentifier } from './entities/asset-identifier.entity.js';
import { AssetImportBatch } from './entities/asset-import-batch.entity.js';
import { AssetMovement } from './entities/asset-movement.entity.js';
import { AssetPhoto } from './entities/asset-photo.entity.js';
import { AssetPriceZeroReason } from './entities/asset-price-zero-reason.entity.js';
import { Asset } from './entities/asset.entity.js';
import { TypeOrmAssetsRepository } from './repositories/assets.repository.js';
import { AssetStateService } from './services/asset-state.service.js';
import { AssetPriceZeroService } from './services/asset-price-zero.service.js';
import { AssetTimelineService } from './services/asset-timeline.service.js';
import { AssetsService } from './services/assets.service.js';

@Module({
  imports: [
    AuthModule,
    CategoriesModule,
    CostCentersModule,
    LocationsModule,
    DynamicFieldsModule,
    MovementsModule,
    RolesModule,
    TypeOrmModule.forFeature([
      Asset,
      AssetCustomValue,
      AssetMovement,
      AssetPhoto,
      AssetImportBatch,
      AssetIdentifier,
      AssetPriceZeroReason,
      AcquisitionType,
      AssetCategory,
      CostCenter,
      Location,
    ]),
  ],
  // AssetPriceZeroController primero: /assets/price-zero no debe caer en GET /assets/:id.
  controllers: [AssetPriceZeroController, AssetsController],
  providers: [
    AssetsService,
    AssetTimelineService,
    AssetPriceZeroService,
    AssetStateService,
    AssetReadScopeGuard,
    { provide: 'AssetsRepository', useClass: TypeOrmAssetsRepository },
  ],
  exports: ['AssetsRepository', AssetsService, AssetStateService],
})
export class AssetsModule {}
