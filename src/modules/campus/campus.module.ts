import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { Building } from '../buildings/entities/building.entity.js';
import { CampusController } from './campus.controller.js';
import { Campus } from './entities/campus.entity.js';
import { TypeOrmCampusRepository } from './repositories/campus.repository.js';
import { CampusService } from './services/campus.service.js';

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([Campus, Building])],
  controllers: [CampusController],
  providers: [
    CampusService,
    { provide: 'CampusesRepository', useClass: TypeOrmCampusRepository },
  ],
  exports: ['CampusesRepository'],
})
export class CampusModule {}
