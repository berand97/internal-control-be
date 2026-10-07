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
import { OrgStructureHistoryService } from './services/org-structure-history.service.js';
import { StructureRemovalService } from './services/structure-removal.service.js';

@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([CostCenter, CostCenterSyncLog, OrganizationalUnit]),
  ],
  controllers: [CostCentersController],
  providers: [
    CostCentersService,
    CostCenterPlacementService,
    StructureRemovalService,
    OrgStructureHistoryService,
    { provide: 'CostCentersRepository', useClass: TypeOrmCostCentersRepository },
  ],
  exports: ['CostCentersRepository', CostCenterPlacementService, StructureRemovalService, OrgStructureHistoryService],
})
export class CostCentersModule {}
