import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { Campus } from '../campus/entities/campus.entity.js';
import { Location } from '../locations/entities/location.entity.js';
import { BuildingsController } from './buildings.controller.js';
import { Building } from './entities/building.entity.js';
import { TypeOrmBuildingsRepository } from './repositories/buildings.repository.js';
import { BuildingsService } from './services/buildings.service.js';

@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([Building, Campus, Location]),
  ],
  controllers: [BuildingsController],
  providers: [
    BuildingsService,
    { provide: 'BuildingsRepository', useClass: TypeOrmBuildingsRepository },
  ],
  exports: ['BuildingsRepository'],
})
export class BuildingsModule {}
