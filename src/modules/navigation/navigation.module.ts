import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NavigationItemEntity } from './entities/navigation-item.entity.js';
import { NavigationController } from './navigation.controller.js';
import { TypeOrmNavigationRepository } from './repositories/navigation.repository.js';
import { NavigationService } from './services/navigation.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([NavigationItemEntity])],
  controllers: [NavigationController],
  providers: [
    NavigationService,
    { provide: 'NavigationRepository', useClass: TypeOrmNavigationRepository },
  ],
  exports: [NavigationService],
})
export class NavigationModule {}
