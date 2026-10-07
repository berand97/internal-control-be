import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { CostCentersModule } from '../cost-centers/cost-centers.module.js';
import { RolesModule } from '../roles/roles.module.js';
import { OrgChartService } from './org-chart/org-chart.service.js';
import { CostCenter } from '../cost-centers/entities/cost-center.entity.js';
import { OrganizationalUnit } from './entities/organizational-unit.entity.js';
import { OrganizationalUnitsController } from './organizational-units.controller.js';
import { TypeOrmOrganizationalUnitsRepository } from './repositories/organizational-units.repository.js';
import { OrganizationalUnitsService } from './services/organizational-units.service.js';

@Module({
  imports: [
    AuthModule,
    CostCentersModule,
    RolesModule,
    TypeOrmModule.forFeature([OrganizationalUnit, CostCenter]),
  ],
  controllers: [OrganizationalUnitsController],
  providers: [
    OrganizationalUnitsService,
    OrgChartService,
    {
      provide: 'OrganizationalUnitsRepository',
      useClass: TypeOrmOrganizationalUnitsRepository,
    },
  ],
  exports: ['OrganizationalUnitsRepository'],
})
export class OrganizationalUnitsModule {}
