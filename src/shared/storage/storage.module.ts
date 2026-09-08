import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../../modules/auth/auth.module.js';
import { StorageSettings } from './entities/storage-settings.entity.js';
import { StorageController } from './storage.controller.js';
import { StorageService } from './storage.service.js';

@Global()
@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([StorageSettings])],
  controllers: [StorageController],
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
