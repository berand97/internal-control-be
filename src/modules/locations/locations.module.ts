import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { Building } from '../buildings/entities/building.entity.js';
import { Campus } from '../campus/entities/campus.entity.js';
import { Location } from './entities/location.entity.js';
import { LocationsController } from './locations.controller.js';
import { TypeOrmLocationsRepository } from './repositories/locations.repository.js';
import { LocationsService } from './services/locations.service.js';

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([Location, Building, Campus])],
  controllers: [LocationsController],
  providers: [
    LocationsService,
    { provide: 'LocationsRepository', useClass: TypeOrmLocationsRepository },
  ],
  exports: ['LocationsRepository'],
})
export class LocationsModule {}
