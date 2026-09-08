import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { AssetCategory } from '../categories/entities/asset-category.entity.js';
import { DynamicFieldsController } from './dynamic-fields.controller.js';
import { AssetCategoryField } from './entities/asset-category-field.entity.js';
import { TypeOrmDynamicFieldsRepository } from './repositories/dynamic-fields.repository.js';
import { DynamicFieldsService } from './services/dynamic-fields.service.js';

@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([AssetCategoryField, AssetCategory]),
  ],
  controllers: [DynamicFieldsController],
  providers: [
    DynamicFieldsService,
    {
      provide: 'DynamicFieldsRepository',
      useClass: TypeOrmDynamicFieldsRepository,
    },
  ],
  exports: ['DynamicFieldsRepository', DynamicFieldsService],
})
export class DynamicFieldsModule {}
