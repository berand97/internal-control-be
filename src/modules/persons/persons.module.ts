import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { RolesModule } from '../roles/roles.module.js';
import { CostCenterHeadsController } from './cost-center-heads.controller.js';
import { PersonsController } from './persons.controller.js';
import { CostCenterHeadsService } from './services/cost-center-heads.service.js';
import { PersonDirectoryService } from './services/person-directory.service.js';

@Module({
  imports: [AuthModule, RolesModule],
  controllers: [PersonsController, CostCenterHeadsController],
  providers: [PersonDirectoryService, CostCenterHeadsService],
})
export class PersonsModule {}
