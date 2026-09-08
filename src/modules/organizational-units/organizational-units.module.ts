import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { CostCenter } from '../cost-centers/entities/cost-center.entity.js';
import { OrganizationalUnit } from './entities/organizational-unit.entity.js';
import { OrganizationalUnitsController } from './organizational-units.controller.js';
import { TypeOrmOrganizationalUnitsRepository } from './repositories/organizational-units.repository.js';
import { OrganizationalUnitsService } from './services/organizational-units.service.js';

@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([OrganizationalUnit, CostCenter]),
  ],
  controllers: [OrganizationalUnitsController],
  providers: [
    OrganizationalUnitsService,
    {
      provide: 'OrganizationalUnitsRepository',
      useClass: TypeOrmOrganizationalUnitsRepository,
    },
  ],
  exports: ['OrganizationalUnitsRepository'],
})
export class OrganizationalUnitsModule {}
