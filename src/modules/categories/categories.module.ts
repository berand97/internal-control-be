import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { CategoriesController } from './categories.controller.js';
import { AssetCategory } from './entities/asset-category.entity.js';
import { TypeOrmCategoriesRepository } from './repositories/categories.repository.js';
import { CategoriesService } from './services/categories.service.js';

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([AssetCategory])],
  controllers: [CategoriesController],
  providers: [
    CategoriesService,
    { provide: 'CategoriesRepository', useClass: TypeOrmCategoriesRepository },
  ],
  exports: ['CategoriesRepository'],
})
export class CategoriesModule {}
