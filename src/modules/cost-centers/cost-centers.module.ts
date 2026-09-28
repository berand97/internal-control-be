import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { OrganizationalUnit } from '../organizational-units/entities/organizational-unit.entity.js';
import { CostCentersController } from './cost-centers.controller.js';
import { CostCenter } from './entities/cost-center.entity.js';
import { CostCenterSyncLog } from './entities/cost-center-sync-log.entity.js';
import { TypeOrmCostCentersRepository } from './repositories/cost-centers.repository.js';
import { CostCenterPlacementService } from './services/cost-center-placement.service.js';
import { CostCentersService } from './services/cost-centers.service.js';

@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([CostCenter, CostCenterSyncLog, OrganizationalUnit]),
  ],
  controllers: [CostCentersController],
  providers: [
    CostCentersService,
    CostCenterPlacementService,
    { provide: 'CostCentersRepository', useClass: TypeOrmCostCentersRepository },
  ],
  exports: ['CostCentersRepository', CostCenterPlacementService],
})
export class CostCentersModule {}
